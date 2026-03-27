# Frame Application by Wall Condition

## Purpose
Normalized reference for selecting frame throat/application from wall condition during commercial quote intake.

## Use Rules
- Do **not** infer wall build-up unless all required wall inputs are explicit.
- For existing finished openings, preserve `match_existing` when requested.
- For non-drywall conditions (masonry/concrete/other), do not use the drywall chart.
- If required inputs are missing, set `verify_required: yes`.

## Required Inputs
- wall_type (`drywall | masonry | concrete | existing_frame_replacement | other`)
- stud_size_label (`3-1/2 | 3-5/8 | 4 | 5-1/2 | 5-5/8 | 6 | unknown`)
- side_1_finish (`1/2 | 5/8 | unknown`)
- side_2_finish (`1/2 | 5/8 | unknown`)
- side_1_layers (`1 | 2 | unknown`)
- side_2_layers (`1 | 2 | unknown`)
- match_existing (`yes/no`)

## Canonical Output Fields
```yaml
knowledge_base: frame_application_by_wall_condition
wall_type: "drywall | masonry | concrete | existing_frame_replacement | other"
stud_size_label: "3-1/2 | 3-5/8 | 4 | 5-1/2 | 5-5/8 | 6 | unknown"
finish_profile: string
frame_size_label: string
frame_size_in_decimal: number
application_recommendation: "kd_drywall | welded_new_construction | match_existing | verify_required"
verify_required: "yes | no"
confidence: "high | medium"
source_ref: string
notes: string
```

## Reference Data (Drywall Chart)

| Row ID | Wall Setup (Side 1 x Side 2) | 3 1/2 stud | 3 5/8 stud | 4 stud | 5 1/2 stud | 5 5/8 stud | 6 stud |
|---|---|---|---|---|---|---|---|
| `DW_12x12` | 1/2 x 1/2 | 5 1/2 frame | 5 5/8 frame | 6 frame | 7 1/2 frame | 7 5/8 frame | 8 frame |
| `DW_12x58` | 1/2 x 5/8 | 5 5/8 frame | 5 3/4 frame | 6 1/8 frame | 7 5/8 frame | 7 3/4 frame | 8 1/8 frame |
| `DW_58x58` | 5/8 x 5/8 | 5 3/4 frame | 5 7/8 frame | 6 1/4 frame | 7 3/4 frame | 7 7/8 frame | 8 1/4 frame |
| `DW_2x12__1x12` | (2) 1/2 x (1) 1/2 | 6 frame | 6 1/8 frame | 6 1/2 frame | 8 frame | 8 1/8 frame | 8 1/2 frame |
| `DW_2x12__2x12` | (2) 1/2 x (2) 1/2 | 6 1/2 frame | 6 5/8 frame | 7 frame | 8 1/2 frame | 8 5/8 frame | 9 frame |
| `DW_2x58__1x58` | (2) 5/8 x (1) 5/8 | 6 3/8 frame | 6 1/2 frame | 6 7/8 frame | 8 3/8 frame | 8 1/2 frame | 8 7/8 frame |
| `DW_2x58__2x58` | (2) 5/8 x (2) 5/8 | 7 frame | 7 1/8 frame | 7 1/2 frame | 9 frame | 9 1/8 frame | 9 1/2 frame |

## Application Logic
1. Identify wall type first.
2. If `wall_type=drywall`, require stud size + both side finish/layer inputs.
3. Match row + stud column exactly.
4. Output frame size only when all required drywall inputs are known.
5. Application recommendation:
   - `kd_drywall` for existing finished drywall openings (when explicit).
   - `welded_new_construction` for new framing before finishes (when explicit).
   - `match_existing` when customer requires existing condition match.
   - `verify_required` when any critical variable is unknown.

## Do Not Assume
- Drywall on both sides.
- Equal board thickness on both sides.
- Double-layer board from fire intent alone.
- Stud size from “metal stud” wording alone.
- Correct frame throat from rough opening alone.

## Suggested Chatbot Prompt Rule
```text
For drywall frame sizing, ask for stud size plus finish thickness/layer count on both sides before selecting frame size. If any are unknown, return verify_required.
```

## Source Metadata
- source_type: image-transcribed internal reference
- source_artifacts:
  - `20260325_143450.jpg`
  - `functions/api/tests/reference-guide (1).json`
- unit_system: inches
- revision_note: normalized with canonical schema + row IDs for deterministic retrieval
