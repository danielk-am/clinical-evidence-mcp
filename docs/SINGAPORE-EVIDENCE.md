# Singapore evidence boundaries

Use separate states for clinical evidence, regulatory registration, subsidy, formulary availability, retail stock, and price. None implies another.

## Machine-readable source

The first Singapore integration uses HSA's [Listing of Registered Therapeutic Products](https://data.gov.sg/datasets/d_767279312753558cbf19d48344577084/view) through data.gov.sg's documented [dataset search API](https://guide.data.gov.sg/developer-guide/dataset-apis/search-and-filter-within-dataset). It provides HSA licence number, product name, classification, ingredient, strength, dosage form, route, licence holder, manufacturer, and approval date.

The second integration uses MOH's [Healthier SG Whitelisted Drugs](https://data.gov.sg/datasets/d_2a57d4e672be2a52118ae0bf4a0f4a4b/view). It provides medication and SDL or MAF class for the Healthier SG Chronic Tier. It is not the complete Singapore subsidised-drug list and does not establish individual subsidy entitlement or amount.

Both datasets are reusable under the [Singapore Open Data Licence](https://data.gov.sg/open-data-licence). Every result must retain the source, retrieval time, dataset update time, required attribution, licence link, and no-endorsement warning. The server caches metadata for one hour and limits calls within the documented ten-second request window. Production deployments should still use a data.gov.sg API key.

The dataset is a snapshot. The tool must not convert a match into a claim about current registration, efficacy, subsidy, stock, price, recommendation, or suitability. A missing match is also inconclusive because spellings and snapshot lag can affect results.

## Manual sources

Use these official sources for editorial verification. They have no documented public search API suitable for this service, and their published reuse terms must be reviewed before ingestion or commercial republication.

| Source | Check |
| --- | --- |
| HSA Infosearch | Current registration status and approved package insert or patient leaflet |
| National Drug Formulary | Singapore drug monographs, subsidy status, and general public-institution formulary availability |
| MOH list of subsidised drugs | Current Standard Drug List and Medication Assistance Fund entries |
| ACE clinical guidance | Singapore evidence reviews, recommendations, and subsidy guidance when available |
| CDA and HealthHub | Local disease, vaccination, medicine, and patient-safety information |

Do not automate HSA Infosearch's CAPTCHA or scrape sources that do not grant machine access. Create a manual verification queue when a current-status claim matters.

## Singapore healthcare financing

“Medicare” is the United States programme name. For Singapore, use “healthcare financing and subsidies” and distinguish MediSave, MediShield Life, CHAS, MediFund, the Standard Drug List, and the Medication Assistance Fund. Eligibility, subsidy class, formulary availability, and a patient's final out-of-pocket cost are separate questions.

MOH hospital-bill and fee-benchmark data is not a retail pharmacy-price source. No official public product-level medicine-price API was found.

## Corrected antiviral example

The source checks prompted by the original failure support this narrower statement:

- Current National Drug Formulary pages confirm registered acyclovir and valaciclovir products.
- Acyclovir tablets at 200 mg, 400 mg, and 800 mg are listed on the Standard Drug List.
- Valaciclovir is listed without subsidy.
- Famciclovir is named in local shingles information, but no current Singapore product registration was confirmed. It needs a manual HSA Infosearch check.

Do not state that all three drugs are currently registered. Do not invent a reason for the subsidy difference.

## Commerce boundary

Keep retail offers in a separate service. The safe order is:

1. Rank ingredient and formulation evidence without merchant or commission data.
2. Apply HSA classification and registration gates.
3. Apply advertising and product-claim rules.
4. Match exact products using HSA licence number for therapeutic products and GTIN or EAN plus formulation and pack size for other products.
5. Fetch authorised price and stock data with timestamps.
6. Add the affiliate link and disclosure only after ranking is final.

Exclude prescription-only medicines from public affiliate merchandising. Pharmacy-only medicines need a separate licensed-pharmacy and advertising review. Never describe a health supplement as HSA-approved or turn ingredient-level evidence into a disease-treatment claim for a retail product.
