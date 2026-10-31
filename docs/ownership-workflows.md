# Transfer and possession in Pakistan

The dashboard uses a general case checklist because requirements differ between development authorities, housing societies, property types and legal cases. It does not certify legal ownership or submit a government registration.

## Transfer

1. Select a confirmed booking and the new owner. This workflow transfers the full recorded ownership to one customer and retains previous owners in history.
2. Enter the authority/society and the supporting case-file references. Check identities, original ownership documents, signed applications, owner/buyer consent, and applicable taxes and fees (or documented exemptions).
3. For authority clearance, choose **Verified** and record the NDC/NOC/dues-clearance reference, with its expiry when the document specifies one. Choose **Not required** only when applicable and record the authority rule or confirmation supporting that decision. A separate NDC record in this application is no longer compulsory.
4. Save the request. For non-zero transfer charges, another authorised employee must verify the fee before completion.
5. Complete the transfer after external authority requirements have been met. The server rechecks scheduled dues, eligibility, the verification record, clearance expiry and current owners.

## Possession

1. Select the confirmed booking, complete the common document checks, and verify that possession has been released for the relevant property/phase. Record applicable site-plan, demarcation and building/utility checks.
2. Record the inspection and any snags. Resolve every snag before handover.
3. Complete handover with the signed acknowledgement reference and the name of the owner or authorised recipient. The server rechecks ownership, applicable clearance expiry and scheduled dues.

Both workflows retain the existing business rule that **all scheduled booking dues must be cleared**. This is an application rule, not a claim that every Pakistani authority applies an identical payment policy. Applicable taxes and authority fees must be verified from current official requirements; the application does not calculate or hardcode statutory rates.

Use **Review case documents** on a pending request to update evidence or renew expired clearance. The audit trail records the reviewer and timestamp. A possession request reviewed for a previous owner must be reviewed again for the current owner. Existing transfers linked to a valid, approved legacy NDC remain supported; existing pending possession requests need the new document review before handover.

Store originals and supporting copies in the case file; references may point to files in the dashboard’s Documents area or the organisation’s controlled records. The checklist records staff verification and references, not an automated authenticity check. Attorney, corporate, overseas, inheritance and gift cases need their applicable additional documents; multi-beneficiary legal distributions are not automated by this full-transfer workflow.

## Official sources reviewed on 16 October 2026

- [DHA Lahore transfer requirements](https://dhalahore.org/dha-facilities/transfer/): NDC, identification, original ownership documentation, transfer formalities, fees/taxes and case-specific supporting documents. DHA's NDC requirement remains relevant even though the dashboard no longer forces a separate internal NDC record.
- [CDA procedures](https://www.cda.gov.pk/procedures): transfer applications and consent, identification and allotment documents, fees, conditional NOCs and possession applications.
- [DHA Lahore building control](https://dhalahore.org/dha-facilities/building-control/) and [building control forms](https://dhalahore.org/building-control-forms/): possession/site-plan and demarcation procedures.

The shared checklist is a synthesis for recordkeeping, not a single nationwide legal checklist. Confirm current requirements with the responsible authority for each case.

## Deployment

Deploy frontend and backend together: new requests contain `verification`; possession handover also needs `handoverReference` and `receivedByName`. The migration `202610160001_ownership_verification` adds these fields and makes the legacy transfer NDC link optional without deleting data.

Release through the [backend production pipeline](deployment.md#production-pipeline), which applies migrations and recreates API and worker in the existing `pms` project.

Publish the matching frontend build through the existing deployment workflow, then refresh the browser.
