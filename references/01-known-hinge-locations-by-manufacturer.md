# Known Hinge Locations by Manufacturer

## Purpose
Reference sheet for standard hinge location patterns by frame manufacturer for commercial door/frame quote intake.

## Use Rules
- Use only when manufacturer is confirmed.
- If manufacturer is unknown, do **not** assume hinge locations.
- If a manufacturer has multiple standards/series, capture exact pattern/series.
- If field conditions conflict with this reference, set `verify_required: yes`.
- If customer says `match existing`, preserve that requirement even if table data exists.

## Required Inputs
- manufacturer
- series_or_product_line (if known)
- door_height
- hinge_count
- match_existing (yes/no)
- existing_pattern_name_or_template (if known)

## Canonical Output Fields
```yaml
knowledge_base: hinge_locations_by_manufacturer
manufacturer: string
manufacturer_family: string
series_or_product_line: string
door_height_label: "6-8 | 7-0 | 7-2 | 8-0 | other"
hinge_count: 3 | 4 | unknown
pattern_id: string
positions:
  - position: "Top | Middle | Bottom | Hinge 1 | Hinge 2 | Hinge 3 | Hinge 4"
    door_from_top_in: string
    frame_from_top_in: string
measurement_rule:
  door_reference: "top of door to top of hinge"
  frame_reference: "door + 1/8 in"
confidence: "high | medium"
verify_required: "yes | no"
source_ref: string
notes: string
```

## Measurement Rules (Critical)
- Door measurement reference: **top of door to top of hinge**.
- Frame measurement reference: **door location + 1/8 in**.
- Example: `4-7/8"` (door) → `5"` (frame).

## Reference Data

### Mesker

#### 6'8" Door (3 Hinges)
- `pattern_id`: `MESKER_6_8_3H_STD`
- `confidence`: `high`
- `source_ref`: `shop_reference_mesker_standard`

| Position | Door | Frame |
|---|---|---|
| Top | 4-7/8" | 5" |
| Middle | 35-1/8" | 35-1/4" |
| Bottom | 65-3/8" | 65-1/2" |

#### 7'0" Door (3 Hinges)
- `pattern_id`: `MESKER_7_0_3H_STD`
- `confidence`: `high`
- `source_ref`: `shop_reference_mesker_standard`

| Position | Door | Frame |
|---|---|---|
| Top | 4-7/8" | 5" |
| Middle | 37-1/8" | 37-1/4" |
| Bottom | 69-3/8" | 69-1/2" |

#### 7'2" Door (3 Hinges)
- `pattern_id`: `MESKER_7_2_3H_DERIVED`
- `confidence`: `medium`
- `source_ref`: `derived_spacing_progression`
- `notes`: `Derived from progression; verify when matching existing frame.`

| Position | Door | Frame |
|---|---|---|
| Top | 4-7/8" | 5" |
| Middle | 38-1/8" | 38-1/4" |
| Bottom | 71-3/8" | 71-1/2" |

#### 8'0" Door (4 Hinges)
- `pattern_id`: `MESKER_8_0_4H_STD`
- `confidence`: `high`
- `source_ref`: `shop_reference_mesker_standard`

| Position | Door | Frame |
|---|---|---|
| Hinge 1 | 4-7/8" | 5" |
| Hinge 2 | 35-1/8" | 35-1/4" |
| Hinge 3 | 65-3/8" | 65-1/2" |
| Hinge 4 | 81-3/8" | 81-1/2" |

### Curries
- `notes`: `No direct row set in this file. Do not substitute Mesker automatically; verify or match existing.`

### Pioneer
- `notes`: `No direct row set in this file. Do not substitute Mesker automatically; verify or match existing.`

### Steelcraft / Republic / Amweld (family)

#### 6'8" Door (3 Hinges)
- `pattern_id`: `STEEL_FAMILY_6_8_3H_STD`
- `confidence`: `high`
- `source_ref`: `shop_reference_steel_family`

| Position | Door | Frame |
|---|---|---|
| Top | 7-3/8" | 7-1/2" |
| Middle | 37-5/16" | 37-7/16" |
| Bottom | 67-1/4" | 67-3/8" |

#### 7'0" Door (3 Hinges)
- `pattern_id`: `STEEL_FAMILY_7_0_3H_STD`
- `confidence`: `high`
- `source_ref`: `shop_reference_steel_family`

| Position | Door | Frame |
|---|---|---|
| Top | 7-3/8" | 7-1/2" |
| Middle | 39-5/16" | 39-7/16" |
| Bottom | 71-1/4" | 71-3/8" |

#### 7'2" Door (3 Hinges)
- `pattern_id`: `STEEL_FAMILY_7_2_3H_STD`
- `confidence`: `medium`
- `source_ref`: `shop_reference_steel_family`

| Position | Door | Frame |
|---|---|---|
| Top | 7-3/8" | 7-1/2" |
| Middle | 40-1/4" | 40-3/8" |
| Bottom | 73" | 73-1/8" |

#### 8'0" Door (4 Hinges)
- `pattern_id`: `STEEL_FAMILY_8_0_4H_STD`
- `confidence`: `high`
- `source_ref`: `shop_reference_steel_family`

| Position | Door | Frame |
|---|---|---|
| Hinge 1 | 7-3/8" | 7-1/2" |
| Hinge 2 | 37-5/16" | 37-7/16" |
| Hinge 3 | 67-1/4" | 67-3/8" |
| Hinge 4 | 83-5/16" | 83-7/16" |

### Ceco

#### 6'8" Door (3 Hinges)
- `pattern_id`: `CECO_6_8_3H_STD`
- `confidence`: `high`
- `source_ref`: `shop_reference_ceco_standard`

| Position | Door | Frame |
|---|---|---|
| Top | 6-5/8" | 6-3/4" |
| Middle | 37-5/8" | 37-3/4" |
| Bottom | 68-5/8" | 68-3/4" |

#### 7'0" Door (3 Hinges)
- `pattern_id`: `CECO_7_0_3H_STD`
- `confidence`: `high`
- `source_ref`: `shop_reference_ceco_standard`

| Position | Door | Frame |
|---|---|---|
| Top | 6-5/8" | 6-3/4" |
| Middle | 39-5/8" | 39-3/4" |
| Bottom | 72-5/8" | 72-3/4" |

#### 8'0" Door (4 Hinges)
- `pattern_id`: `CECO_8_0_4H_STD`
- `confidence`: `high`
- `source_ref`: `shop_reference_ceco_standard`

| Position | Door | Frame |
|---|---|---|
| Hinge 1 | 6-5/8" | 6-3/4" |
| Hinge 2 | 37-5/8" | 37-3/4" |
| Hinge 3 | 68-5/8" | 68-3/4" |
| Hinge 4 | 83-1/4" | 83-3/8" |

## Intake Guidance for Chatbot
1. Ask manufacturer first.
2. Ask door height and hinge count.
3. If customer says `match existing`, preserve that and avoid substitutions.
4. If no table is available for that manufacturer/series, ask for field measurements and set `verify_required: yes`.

## Do Not Assume
- Cross-manufacturer compatibility.
- Universal “standard” hinge locations.
- 3 vs 4 hinges without height/condition confirmation.
- That 7'2" always follows 7'0" without verification.

## Source Metadata
- source_type: internal_shop_reference
- unit_system: inches
- maintained_by: Castle Door quote intake references
- revision_note: normalized schema + confidence/source tagging added
