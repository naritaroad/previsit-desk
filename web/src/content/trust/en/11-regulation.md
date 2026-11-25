---
title: Regulation
summary: Which rules we compared the design with, which originals we read or did not read, and why we claim no compliance.
version: "2.0"
effective: 2026-11-25
owner: naritaroad (project author)
reviewer: No external clinical review
next_review: 2027-02-25
---

## How to read this page

This is a record of what the author read and how the design compares, so that people who know the law can point out mistakes. It is not legal advice, and no sentence here says that the system complies with any law (C-40). The system has not applied for a medical-device classification and holds no licence. Each item names the document and how it was read.

| Rule | What was read | What was not |
|---|---|---|
| MOHW guideline on generative AI in medical institutions | The notice and the full 14-page PDF | None |
| Telemedicine regulations (通訊診察治療辦法) | The ministry's 2024 summary and article comparison (Articles 2, 3, 15 to 22) | Whether they were amended after 2024 |
| Physicians Act | Taipei City law system, version of 22 June 2022 | Later amendments |
| Pharmacists Act | Articles in the 1979 presidential gazette | The current text |
| NHI medical care regulations | The text PDF on the ministry's site (including the June 2024 amendment) | Later amendments |
| Personal Data Protection Act | Taipei City law system, version of 11 November 2025 | Effective date, enforcement rules |
| DCB0129, DCB0160, DTAC | The NHS standards pages and a news page | Full text of the standards and the form |

The national law database could not be reached on the day, so most texts were read on other government sites.

## Guideline on generative AI

The Ministry of Health and Welfare issued the guideline on 29 May 2026. It describes itself as administrative guidance without legal force, addressed to medical institutions. Personal research, teaching demonstrations and internal functional tests may refer to its principles where suitable. Once real patient data or clinical workflows are involved, the activity counts as adoption and the guideline should be followed (C-38, [ref. 8][r8]). This project belongs to the first group, so what follows is "by reference".

Where AI talks directly with the public, the guideline says to disclose it, to warn that output may be wrong and is for reference only, and to have clinicians confirm when necessary. We do this with a fixed opening message, a permanent banner and a label on the summary.

For uses that involve clinical judgement, patient safety, communication with patients or medical records, it says qualified staff should have final confirmation and responsibility. We leave assessment, plan, renewal decisions and signing to physician accounts. There is no real physician behind the demo accounts, so as things stand this is not met.

It suggests a risk inventory, a data protection assessment, clinical safety testing and explicit acceptance criteria before adoption, then continued monitoring of error types and rates of manual change, with conditions for stopping set in advance. We have a hazard log, evaluation thresholds, oversight metrics and an off switch. We do not have a separate responsible unit, a data protection assessment, an isolated test environment or a clinical trial site.

It suggests requiring suppliers, by contract, to disclose the language model they use. We publish the primary and fallback model names on this site.

It leaves AI agent systems outside its scope because their autonomy raises the risk. "How it works" describes the limits on our tools.

## Telemedicine regulations

The system does not provide telemedicine. We compared the articles to see where the line is. Article 15 lists taking a history, prescribing and health education among telemedicine items. Article 16 limits who may be prescribed what. Article 18 requires an approved plan from the institution, Article 19 requires identity verification, encryption and security validation, and Article 20 requires informed consent, confirmation of identity and a medical record (C-39, [ref. 9][r9]). A clinic that connects pre-visit intake to online consultations will meet these requirements. "The AI only asks questions" does not settle them.

## Physicians Act and Pharmacists Act

The rule of examination in person (Article 11), medical records (Article 12), prescriptions (Article 13) and the penalty for practising without qualifications (Article 28) are why we do not diagnose, prescribe or give doses ([ref. 11][r11]). Which automated acts count as medical practice is for regulators or lawyers to say. We chose only to stay some distance from the line.

The principle of the Pharmacists Act is to dispense according to the prescription, ask the prescriber about doubts first, and not omit or substitute at will ([ref. 19][r19]). The pharmacy site's return and query steps follow that order.

## NHI medical care regulations

The days, windows and controlled-drug rule for refillable prescriptions are stored as data with the article they come from, and the code applies them ([ref. 10][r10]). Known differences are in "Renewals and refills". The system is not connected to the NHI Administration, so the dates it computes have no bearing on payment.

## Personal Data Protection Act

Article 6 says data on medical records, treatment, health examinations and the like may in principle not be collected, processed or used. Article 3 lists the rights of the person concerned. Article 8 lists what must be told at collection. Article 11 requires deletion when the purpose ends or the period expires ([ref. 12][r12]). In the design, these correspond to accepting only fictional data, offering export and deletion, deleting automatically, and publishing the purpose and retention period. If someone enters real data against the notices, we can mask and delete, but cannot guarantee that this is lawful.

The model provider is abroad, so content crosses borders. That is another reason for not accepting real data.

## References from abroad

The NHS lists DCB0129 and DCB0160 as active. NHS England held a consultation on updating both, for developments including AI, from 29 June to 11 September 2026, and no outcome has been published ([ref. 15][r15], [ref. 16][r16], [ref. 17][r17]). DTAC is the form the NHS uses to assess digital health products. It was replaced by a new version in 2026 and the old one was retired from 6 April ([ref. 18][r18]). We have not filled in DTAC and are not among the products it is meant for.

The model provider's terms forbid use in clinical practice or to provide medical advice, and forbid uses that need clearance from a medical-device regulator ([ref. 14][r14]). That alone is enough to keep this system at the demonstration stage.

[r8]: https://www.mohw.gov.tw/cp-18-86695-1.html
[r9]: https://www.mohw.gov.tw/dl-86975-40690d3a-b8e0-4a5c-b435-d660e48e73e7.html
[r10]: https://www.mohw.gov.tw/dl-93633-3bde2ef4-420d-4498-b056-e54019bab357.html
[r11]: https://laws.gov.taipei/law/LawSearch/LawPrint/FL013514?type=0
[r12]: https://laws.gov.taipei/law/LawSearch/LawExport/FL010627?type=0
[r14]: https://aistudio.google.com/docs/terms
[r15]: https://standards.nhs.uk/published-standards/clinical-risk-management-its-application-in-the-manufacture-of-health-it-systems
[r16]: https://standards.nhs.uk/published-standards/clinical-risk-management-its-application-in-the-deployment-and-use-of-health-it-systems
[r17]: https://www.engage.england.nhs.uk/patient-safety/national-review-of-clinical-risk-management-standa/
[r18]: https://innovation.nhs.uk/news/updated-nhs-england-digital-technology-assessment-criteria-dtac-form-and-guidance/
[r19]: https://www.president.gov.tw/Page/294/38057
