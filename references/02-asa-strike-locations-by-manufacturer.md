# ASA Strike Locations by Manufacturer

## Purpose
Reference sheet for ASA strike location patterns by manufacturer family for commercial door/frame quote intake.

## Use Rules
- Use only when manufacturer family is confirmed.
- If customer says `match existing`, preserve that requirement.
- If manufacturer is unknown, do not choose a strike location from this file.
- If field measurements conflict with table values, set `verify_required: yes`.

## Required Inputs
- manufacturer_family
- door_height_label (`6-8 | 7-0 | 8-0 | other`)
- strike_type (`ASA | unknown`)
- match_existing (`yes/no`)
- measured_strike_location (if available)

## Canonical Output Fields
```yaml
knowledge_base: asa_strike_locations_by_manufacturer
manufacturer_family: string
door_height_label: "6-8 | 7-0 | 8-0 | other"
strike_point: "E"
door_from_top_in_decimal: number
frame_from_top_in_decimal: number
door_from_top_in_fraction: string
frame_from_top_in_fraction: string
pattern_id: string
confidence: "high"
verify_required: "yes | no"
source_ref: string
notes: string
```

## Measurement Rule
- Door reference: top of door to strike reference point.
- Frame reference: door location + 1/8 in.

## Reference Data (ASA Strike Point E)

| Manufacturer Family | 6-8 Door E (door/frame) | 7-0 Door E (door/frame) | 8-0 Door E (door/frame) | Pattern ID Prefix | Confidence | Source |
|---|---:|---:|---:|---|---|---|
| Spartan/Tell | 39-9/16 / 39-11/16 | 43-9/16 / 43-11/16 | 55-9/16 / 55-11/16 | `SPARTAN_TELL_ASA_E` | high | `reference_guide_internal` |
| Amweld | 39-9/16 / 39-11/16 | 43-9/16 / 43-11/16 | 55-9/16 / 55-11/16 | `AMWELD_ASA_E` | high | `reference_guide_internal` |
| Steelcraft | 39-9/16 / 39-11/16 | 43-9/16 / 43-11/16 | 55-9/16 / 55-11/16 | `STEELCRAFT_ASA_E` | high | `reference_guide_internal` |
| DKS | 39-9/16 / 39-11/16 | 43-9/16 / 43-11/16 | 55-9/16 / 55-11/16 | `DKS_ASA_E` | high | `reference_guide_internal` |
| Old Republic | 39-9/16 / 39-11/16 | 43-9/16 / 43-11/16 | 55-9/16 / 55-11/16 | `OLD_REPUBLIC_ASA_E` | high | `reference_guide_internal` |
| New Republic | 39-9/16 / 39-11/16 | 43-9/16 / 43-11/16 | 55-9/16 / 55-11/16 | `NEW_REPUBLIC_ASA_E` | high | `reference_guide_internal` |
| Kewanee | 39-9/16 / 39-11/16 | 43-9/16 / 43-11/16 | 55-9/16 / 55-11/16 | `KEWANEE_ASA_E` | high | `reference_guide_internal` |
| Dominion | 40 / 40-1/8 | 42 / 42-1/8 | 54 / 54-1/8 | `DOMINION_ASA_E` | high | `reference_guide_internal` |
| Ceco | 38-1/16 / 38-3/16 | 42-1/16 / 42-3/16 | 54-1/16 / 54-3/16 | `CECO_ASA_E` | high | `reference_guide_internal` |
| Fenestra | 39-9/16 / 39-11/16 | 43-9/16 / 43-11/16 | 55-9/16 / 55-11/16 | `FENESTRA_ASA_E` | high | `reference_guide_internal` |
| Pioneer | 41-7/8 / 42 | 45-7/8 / 46 | 57-7/8 / 58 | `PIONEER_ASA_E` | high | `reference_guide_internal` |
| Mesker | 38-15/16 / 39-1/16 | 43-9/16 / 43-11/16 | 55-9/16 / 55-11/16 | `MESKER_ASA_E` | high | `reference_guide_internal` |
| Curries | 39-7/8 / 40 | 43-7/8 / 44 | 55-7/8 / 56 | `CURRIES_ASA_E` | high | `reference_guide_internal` |

## Decimal Quick Reference (Door / Frame)

| Manufacturer Family | 6-8 | 7-0 | 8-0 |
|---|---:|---:|---:|
| Spartan/Tell | 39.5625 / 39.6875 | 43.5625 / 43.6875 | 55.5625 / 55.6875 |
| Amweld | 39.5625 / 39.6875 | 43.5625 / 43.6875 | 55.5625 / 55.6875 |
| Steelcraft | 39.5625 / 39.6875 | 43.5625 / 43.6875 | 55.5625 / 55.6875 |
| DKS | 39.5625 / 39.6875 | 43.5625 / 43.6875 | 55.5625 / 55.6875 |
| Old Republic | 39.5625 / 39.6875 | 43.5625 / 43.6875 | 55.5625 / 55.6875 |
| New Republic | 39.5625 / 39.6875 | 43.5625 / 43.6875 | 55.5625 / 55.6875 |
| Kewanee | 39.5625 / 39.6875 | 43.5625 / 43.6875 | 55.5625 / 55.6875 |
| Dominion | 40 / 40.125 | 42 / 42.125 | 54 / 54.125 |
| Ceco | 38.0625 / 38.1875 | 42.0625 / 42.1875 | 54.0625 / 54.1875 |
| Fenestra | 39.5625 / 39.6875 | 43.5625 / 43.6875 | 55.5625 / 55.6875 |
| Pioneer | 41.875 / 42 | 45.875 / 46 | 57.875 / 58 |
| Mesker | 38.9375 / 39.0625 | 43.5625 / 43.6875 | 55.5625 / 55.6875 |
| Curries | 39.875 / 40 | 43.875 / 44 | 55.875 / 56 |

## Intake Guidance for Chatbot
1. Ask whether customer needs `match existing`.
2. Ask manufacturer family.
3. Ask door height label (`6-8`, `7-0`, `8-0`).
4. If any are unknown, mark `verify_required: yes`.
5. Do not use this file to infer hinge locations; hinge data is separate.

## Do Not Assume
- Same ASA strike location across all manufacturers.
- Same strike location from only handing, size, or hinge pattern.
- That unknown manufacturer can be safely mapped to a known family.

## Source Metadata
- source_type: internal structured reference
- source_artifacts:
  - `functions/api/tests/reference-guide (1).json`
  - `functions/api/chatbot-quote.js`
- unit_system: inches
- revision_note: normalized with canonical schema, confidence tags, and fractional + decimal values
