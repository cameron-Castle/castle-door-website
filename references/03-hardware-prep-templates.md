# Hardware Prep Templates

## Purpose
Normalized reference for common commercial hardware prep labels used during quote intake.

## Use Rules
- Preserve the customer-provided prep code exactly when explicitly stated.
- If customer describes conditions but not the code, map only when description is explicit.
- If prep type is ambiguous, ask one clarifying question instead of assuming.
- If panic hardware is involved, do not assume standard latch prep remains valid.

## Required Inputs
- prep_code_raw (if provided)
- lock_type_intent (`cylindrical | mortise | deadbolt | panic | unknown`)
- latch_intent (`required | not_required | unknown`)
- panic_hardware_present (`yes/no/unknown`)
- match_existing (`yes/no`)

## Canonical Output Fields
```yaml
knowledge_base: hardware_prep_templates
prep_code: "C4 | MB | BLANK | C4+DB | C4BE | UNKNOWN"
prep_type: "cylindrical | mortise | blank | cylindrical_plus_deadbolt | cylindrical_no_latch_exit_device | unknown"
panic_hardware_present: "yes | no | unknown"
latch_prep_required: "yes | no | unknown"
verify_required: "yes | no"
confidence: "high | medium"
source_ref: string
notes: string
```

## Reference Data

### C4
- **Meaning:** Cylindrical prep
- **Pattern ID:** `PREP_C4`
- **Use when:** Standard cylindrical lock/lever prep is requested and no panic exception is stated.
- **Canonical mapping:**
  - `prep_code: C4`
  - `prep_type: cylindrical`
  - `latch_prep_required: yes`
  - `confidence: high`
  - `source_ref: internal_hardware_prep_reference`
- **Do not assume:** backset, lever function, brand, fire-label compatibility.

### MB
- **Meaning:** Mortise prep
- **Pattern ID:** `PREP_MB`
- **Use when:** Mortise lock prep is explicitly requested.
- **Canonical mapping:**
  - `prep_code: MB`
  - `prep_type: mortise`
  - `latch_prep_required: yes`
  - `confidence: high`
  - `source_ref: internal_hardware_prep_reference`
- **Do not assume:** mortise case brand, function, cylinder type, trim type.

### BLANK
- **Meaning:** No hardware prep / blank prep
- **Pattern ID:** `PREP_BLANK`
- **Use when:** No prep is requested or prep is deferred.
- **Canonical mapping:**
  - `prep_code: BLANK`
  - `prep_type: blank`
  - `latch_prep_required: no`
  - `confidence: high`
  - `source_ref: internal_hardware_prep_reference`
- **Do not assume:** strike prep, closer prep, future hardware choice.

### C4+DB
- **Meaning:** Cylindrical prep plus deadbolt prep
- **Pattern ID:** `PREP_C4_DB`
- **Use when:** Both cylindrical and deadbolt preps are explicitly required.
- **Canonical mapping:**
  - `prep_code: C4+DB`
  - `prep_type: cylindrical_plus_deadbolt`
  - `latch_prep_required: yes`
  - `confidence: high`
  - `source_ref: internal_hardware_prep_reference`
- **Do not assume:** vertical relationship between bores, bore spacing, hardware brand.

### C4BE
- **Meaning:** Cylindrical trim prep with no latch prep because opening is for panic hardware
- **Pattern ID:** `PREP_C4BE`
- **Interpretation note:** `cylindrical prep no latch because prepped for panic bar`
- **Use when:** Cylinder/trim prep is needed and latch is controlled by exit device.
- **Canonical mapping:**
  - `prep_code: C4BE`
  - `prep_type: cylindrical_no_latch_exit_device`
  - `latch_prep_required: no`
  - `panic_hardware_present: yes`
  - `confidence: high`
  - `source_ref: internal_hardware_prep_reference`
- **Do not assume:** rim vs CVR device, exit device manufacturer, trim function, dogging.

## Intake Guidance for Chatbot
1. If prep code is explicit, store that code directly.
2. If prep code is not explicit, map only from explicit condition language.
3. If customer mentions panic/exit device and cylindrical trim, test for `C4BE` intent.
4. If uncertain between cylindrical and mortise, ask one direct clarification.
5. If any key element is unknown, set `verify_required: yes`.

## Do Not Assume
- Prep templates from door size alone.
- Latch prep presence when panic hardware is implied but not confirmed.
- Brand/template compatibility without manufacturer/series confirmation.

## Source Metadata
- source_type: internal normalized reference
- source_artifacts:
  - `functions/api/reference-guide.md`
  - `functions/api/tests/reference-guide (1).json`
- revision_note: normalized with canonical schema + confidence/source tagging
