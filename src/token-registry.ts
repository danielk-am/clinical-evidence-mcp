import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const TOKEN_PREFIX = "cemcp";

interface AccountRecord {
  id: string;
  email: string;
  createdAt: string;
}

interface TokenRecord {
  id: string;
  publicId: string;
  secretDigest: string;
  accountId: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

interface RegistryDocument {
  version: 1;
  accounts: AccountRecord[];
  tokens: TokenRecord[];
}

export interface Principal {
  accountId: string;
  tokenId: string;
}

export interface CreatedToken {
  token: string;
  tokenId: string;
  accountId: string;
  email: string;
  label: string;
  createdAt: string;
}

export interface ListedToken {
  tokenId: string;
  publicId: string;
  accountId: string;
  email: string;
  label: string;
  status: "enabled" | "revoked";
  createdAt: string;
  revokedAt: string | null;
}

export class TokenRegistry {
  readonly filePath: string;
  private readonly lockPath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "tokens.json");
    this.lockPath = join(dataDir, ".tokens.lock");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.filePath), 0o700);
    try {
      await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
      await this.writeDocument({ version: 1, accounts: [], tokens: [] });
    }
  }

  async createToken(email: string, label = "default"): Promise<CreatedToken> {
    const normalizedEmail = normalizeEmail(email);
    const cleanedLabel = label.trim().slice(0, 100) || "default";

    return this.withWriteLock(async () => {
      const document = await this.readDocument();
      let account = document.accounts.find((candidate) => candidate.email === normalizedEmail);
      if (!account) {
        account = {
          id: `acct_${randomUUID()}`,
          email: normalizedEmail,
          createdAt: new Date().toISOString(),
        };
        document.accounts.push(account);
      }

      const publicId = randomBytes(9).toString("base64url");
      const secret = randomBytes(32).toString("base64url");
      const token = `${TOKEN_PREFIX}_${publicId}.${secret}`;
      const createdAt = new Date().toISOString();
      const record: TokenRecord = {
        id: `tok_${randomUUID()}`,
        publicId,
        secretDigest: digestSecret(secret),
        accountId: account.id,
        label: cleanedLabel,
        createdAt,
        revokedAt: null,
      };
      document.tokens.push(record);
      await this.writeDocument(document);

      return {
        token,
        tokenId: record.id,
        accountId: account.id,
        email: account.email,
        label: record.label,
        createdAt,
      };
    });
  }

  async verifyToken(token: string): Promise<Principal | null> {
    const parsed = parseToken(token);
    if (!parsed) {
      return null;
    }
    const document = await this.readDocument();
    const record = document.tokens.find((candidate) => candidate.publicId === parsed.publicId);
    if (!record || record.revokedAt) {
      return null;
    }
    const supplied = Buffer.from(digestSecret(parsed.secret), "hex");
    const expected = Buffer.from(record.secretDigest, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return null;
    }
    return { accountId: record.accountId, tokenId: record.id };
  }

  async listTokens(): Promise<ListedToken[]> {
    const document = await this.readDocument();
    const accounts = new Map(document.accounts.map((account) => [account.id, account]));
    return document.tokens.map((token) => ({
      tokenId: token.id,
      publicId: token.publicId,
      accountId: token.accountId,
      email: accounts.get(token.accountId)?.email ?? "unknown",
      label: token.label,
      status: token.revokedAt ? "revoked" : "enabled",
      createdAt: token.createdAt,
      revokedAt: token.revokedAt,
    }));
  }

  async revokeToken(tokenId: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      const document = await this.readDocument();
      const record = document.tokens.find((candidate) => candidate.id === tokenId);
      if (!record || record.revokedAt) {
        return false;
      }
      record.revokedAt = new Date().toISOString();
      await this.writeDocument(document);
      return true;
    });
  }

  private async readDocument(): Promise<RegistryDocument> {
    await this.initialize();
    const raw = await readFile(this.filePath, "utf8");
    const value = JSON.parse(raw) as Partial<RegistryDocument>;
    if (value.version !== 1 || !Array.isArray(value.accounts) || !Array.isArray(value.tokens)) {
      throw new Error("Token registry has an unsupported format.");
    }
    return value as RegistryDocument;
  }

  private async writeDocument(document: RegistryDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    let handle;
    try {
      handle = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (isFileExists(error)) {
        throw new Error(`Token registry is locked. Remove ${this.lockPath} only if no token command is running.`);
      }
      throw error;
    }
    try {
      await handle.writeFile(`${process.pid}\n`);
      return await operation();
    } finally {
      await handle.close();
      await rm(this.lockPath, { force: true });
    }
  }
}

function parseToken(token: string): { publicId: string; secret: string } | null {
  const match = token.match(/^cemcp_([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{43})$/);
  return match?.[1] && match[2] ? { publicId: match[1], secret: match[2] } : null;
}

function digestSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("A valid email address is required.");
  }
  return normalized;
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isFileExists(error: unknown): boolean {
  return isNodeError(error, "EEXIST");
}

function isNodeError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
