"""Generation pipeline for project datasets, schema, prompt, and runs.

Strategy:
  1. Plan 10 distinct sub-topics within the user's domain (one Opus call).
  2. Generate 10 datasets concurrently (10 parallel Sonnet calls).
  3. Design a JSON Schema with 10+ fields, some nested (one Opus call).
  4. Write the structured prompt that targets that schema (one Opus call).
  5. Execute the prompt against all 10 datasets concurrently and persist
     each structured output as a run.

Datasets + runs use Sonnet 4.6 (cheap + fast for the bulk parallel work).
Schema + prompt use Opus 4.7 (intelligence-sensitive).
"""
import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any, Literal

import anthropic
from pydantic import BaseModel, Field

DATASET_MODEL = "claude-sonnet-4-6"
SCHEMA_MODEL = "claude-opus-4-7"
PROMPT_MODEL = "claude-opus-4-7"
RUN_MODEL = "claude-sonnet-4-6"

DATASET_COUNT = 10


# --------------------------------------------------------------------------- #
# Difficulty (1-10) → generation knobs
# --------------------------------------------------------------------------- #


def difficulty_profile(difficulty: int) -> dict[str, Any]:
    """Map a 1-10 difficulty to concrete knobs for corpus + schema + prompt."""
    d = max(1, min(10, difficulty))
    word_lo = 300 + (d - 1) * 220        # 300 → 2280
    word_hi = 700 + (d - 1) * 380        # 700 → 4120
    min_fields = 10 + (d - 1)            # 10 → 19
    if d <= 3:
        min_nested = 1
    elif d <= 6:
        min_nested = 2
    elif d <= 8:
        min_nested = 3
    else:
        min_nested = 4
    if d <= 2:
        max_depth = 1
    elif d <= 5:
        max_depth = 2
    elif d <= 8:
        max_depth = 3
    else:
        max_depth = 4
    descriptor = {
        1: "very straightforward, plainly written, minimal ambiguity",
        2: "straightforward with light variation in phrasing",
        3: "modestly varied in structure and tone",
        4: "realistic with some ambiguity and missing fields",
        5: "realistic with several ambiguous or implicit signals",
        6: "challenging — interleaved sections, partial information, mixed formats",
        7: "challenging — varied formats, edge cases, occasionally conflicting cues",
        8: "hard — long, dense, with conflicting or partial cues across sections",
        9: "hard — adversarial edge cases, multiple conflicting signals, subtle inferences",
        10: "brutal — adversarial, deeply nested, ambiguous, and information-dense",
    }[d]
    return {
        "difficulty": d,
        "word_lo": word_lo,
        "word_hi": word_hi,
        "min_fields": min_fields,
        "min_nested": min_nested,
        "max_depth": max_depth,
        "descriptor": descriptor,
    }


# --------------------------------------------------------------------------- #
# Pydantic shapes for structured outputs
# --------------------------------------------------------------------------- #


class CorpusPlan(BaseModel):
    archetype: str = Field(
        description=(
            "ONE concrete document type / format characteristic of this "
            "domain that all 10 documents will share. Be specific about "
            "format, structure, sections, and length expectations — e.g. "
            "'a quarterly board meeting minutes document, ~2000 words, "
            "with sections for attendees / agenda items / decisions / "
            "action items'. Every dataset will follow this archetype."
        )
    )
    instances: list[str] = Field(
        description=(
            "Exactly 10 specific scenarios within the archetype. They must "
            "differ in subject matter and details, but produce documents of "
            "the SAME structure and format. They should be similar enough "
            "that a single extraction schema fits all 10 cleanly."
        ),
        min_length=DATASET_COUNT,
        max_length=DATASET_COUNT,
    )


# Backwards-compat alias for any older callers.
TopicPlan = CorpusPlan


class GeneratedDataset(BaseModel):
    title: str = Field(description="Short, descriptive title (≤ 80 chars).")
    content: str = Field(
        description=(
            "A realistic, substantive document in the requested domain — "
            "1500–3000 words. Use the kind of structure a real document "
            "would have (sections, lists, tables in markdown if natural)."
        ),
    )


FieldType = Literal[
    "string",
    "integer",
    "number",
    "boolean",
    "array",
    "object",
    "string_enum",
]


class FieldDef(BaseModel):
    name: str = Field(description="snake_case field name.")
    description: str = Field(description="What this field captures.")
    type: FieldType
    required: bool = True
    enum_values: list[str] | None = Field(
        default=None,
        description="Allowed values when type is 'string_enum'.",
    )
    array_item_type: FieldType | None = Field(
        default=None,
        description="Item type when type is 'array'.",
    )
    nested_fields: list["FieldDef"] | None = Field(
        default=None,
        description=(
            "Nested fields when type is 'object', or when type is 'array' "
            "and array_item_type is 'object'."
        ),
    )


FieldDef.model_rebuild()


class GeneratedSchema(BaseModel):
    title: str = Field(description="Title of the structured output.")
    description: str = Field(description="What this schema extracts and why.")
    fields: list[FieldDef] = Field(
        description=(
            "10 or more top-level fields. AT LEAST TWO must be nested "
            "(type='object' with nested_fields, OR type='array' of objects). "
            "Choose fields that an analyst would actually want to extract "
            "from documents in this domain."
        ),
        min_length=10,
    )


class GeneratedPrompt(BaseModel):
    system_text: str = Field(
        description=(
            "System prompt for the extraction model. Should set persona, "
            "rigor expectations, and output discipline."
        ),
    )
    user_template: str = Field(
        description=(
            "User-turn template. Must contain the literal string "
            "'{{document}}' where the input document will be substituted."
        ),
    )
    notes: str = Field(
        description=(
            "Brief rationale: design choices, edge cases the prompt handles, "
            "what makes it robust."
        ),
    )


# --------------------------------------------------------------------------- #
# JSON Schema conversion
# --------------------------------------------------------------------------- #


def _field_to_json_schema(f: FieldDef) -> dict[str, Any]:
    """Convert one FieldDef to a JSON Schema fragment."""
    if f.type == "string_enum":
        node: dict[str, Any] = {
            "type": "string",
            "description": f.description,
            "enum": f.enum_values or [],
        }
    elif f.type == "object":
        node = {
            "type": "object",
            "description": f.description,
            "properties": {},
            "required": [],
            "additionalProperties": False,
        }
        for sub in f.nested_fields or []:
            node["properties"][sub.name] = _field_to_json_schema(sub)
            if sub.required:
                node["required"].append(sub.name)
    elif f.type == "array":
        item_type = f.array_item_type or "string"
        if item_type == "object":
            items: dict[str, Any] = {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": False,
            }
            for sub in f.nested_fields or []:
                items["properties"][sub.name] = _field_to_json_schema(sub)
                if sub.required:
                    items["required"].append(sub.name)
        else:
            items = {"type": item_type}
        node = {"type": "array", "description": f.description, "items": items}
    else:
        node = {"type": f.type, "description": f.description}
    return node


def schema_to_json_schema(schema: GeneratedSchema) -> dict[str, Any]:
    """Convert GeneratedSchema → standard JSON Schema (Draft-2020-12)."""
    properties: dict[str, Any] = {}
    required: list[str] = []
    for f in schema.fields:
        properties[f.name] = _field_to_json_schema(f)
        if f.required:
            required.append(f.name)
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": schema.title,
        "description": schema.description,
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


# --------------------------------------------------------------------------- #
# Generation steps
# --------------------------------------------------------------------------- #


async def plan_topics(
    client: anthropic.AsyncAnthropic, domain: str, difficulty: int = 5
) -> CorpusPlan:
    """Plan a corpus: pick ONE document archetype and 10 specific instances
    of it. All 10 datasets will share format/structure so a single schema +
    prompt fits them cleanly."""
    p = difficulty_profile(difficulty)
    response = await client.messages.parse(
        model=PROMPT_MODEL,
        max_tokens=4096,
        system=(
            "You design HOMOGENEOUS document corpora for testing structured-"
            "extraction prompts. The 10 documents in a corpus must share a "
            "single, well-defined archetype — same kind of document, same "
            "format, varying only in the specific subject matter."
        ),
        messages=[
            {
                "role": "user",
                "content": (
                    f"Domain: {domain}\n"
                    f"Target difficulty: {p['difficulty']}/10 ({p['descriptor']}).\n\n"
                    "Choose ONE concrete document archetype that an analyst "
                    "would realistically encounter in this domain (e.g. "
                    "'incident post-mortem report', 'quarterly earnings call "
                    "transcript', 'patient discharge summary'). Then list "
                    "exactly 10 specific instances of that archetype — "
                    "different subjects, same format. The 10 documents must "
                    "be similar enough that one extraction schema and prompt "
                    "fit all of them cleanly. Calibrate complexity to the "
                    "requested difficulty (sparse vs dense, plain vs "
                    "ambiguous), but keep the format consistent."
                ),
            }
        ],
        output_format=CorpusPlan,
    )
    return response.parsed_output


async def generate_dataset(
    client: anthropic.AsyncAnthropic,
    domain: str,
    archetype: str,
    instance: str,
    idx: int,
    difficulty: int = 5,
) -> GeneratedDataset:
    p = difficulty_profile(difficulty)
    response = await client.messages.parse(
        model=DATASET_MODEL,
        max_tokens=8000,
        system=(
            "You produce realistic, substantive sample documents for a "
            "structured-extraction testbed. Documents must read like real "
            "artifacts — not summaries, not meta-descriptions. CRITICAL: "
            "documents in a corpus share a single archetype — same format, "
            "same section structure, same conventions — varying only in "
            "the specific subject matter."
        ),
        messages=[
            {
                "role": "user",
                "content": (
                    f"Domain: {domain}\n\n"
                    f"<archetype>\n{archetype}\n</archetype>\n\n"
                    f"<instance>\n{instance}\n</instance>\n\n"
                    f"Index: {idx}/10\n"
                    f"Target difficulty: {p['difficulty']}/10 ({p['descriptor']}).\n\n"
                    "Write a realistic document for this specific instance. "
                    "It MUST follow the archetype exactly — same sections, "
                    "same headings, same overall structure as the other 9 "
                    "documents in this corpus. Vary only the actual subject "
                    "matter and specific details. "
                    f"Length: roughly {p['word_lo']}–{p['word_hi']} words. "
                    "Use natural structure for the archetype (headings, "
                    "bullets, tables in markdown where appropriate). At low "
                    "difficulty, keep facts explicit and well-organised; at "
                    "high difficulty, weave in ambiguity, implicit cues, "
                    "partial or conflicting information. Do NOT include "
                    "meta-commentary."
                ),
            }
        ],
        output_format=GeneratedDataset,
    )
    return response.parsed_output


async def generate_schema(
    client: anthropic.AsyncAnthropic,
    domain: str,
    archetype: str,
    sample_titles: list[str],
    difficulty: int = 5,
) -> GeneratedSchema:
    p = difficulty_profile(difficulty)
    response = await client.messages.parse(
        model=SCHEMA_MODEL,
        max_tokens=8000,
        system=(
            "You design rigorous JSON-schema-shaped data extraction targets. "
            "Your output schemas must capture analytically valuable structure "
            "from domain documents and fit cleanly across all documents in a "
            "homogeneous corpus."
        ),
        messages=[
            {
                "role": "user",
                "content": (
                    f"Domain: {domain}\n"
                    f"Target difficulty: {p['difficulty']}/10 ({p['descriptor']}).\n\n"
                    f"<archetype>\n{archetype}\n</archetype>\n\n"
                    f"Sample document titles in this corpus:\n- "
                    + "\n- ".join(sample_titles)
                    + (
                        f"\n\nDesign a schema for this archetype with at least "
                        f"{p['min_fields']} top-level fields. AT LEAST "
                        f"{p['min_nested']} of the top-level fields must be "
                        f"nested (object with nested fields, or array of "
                        f"objects). You may nest up to {p['max_depth']} levels "
                        "deep. Pick fields an analyst would genuinely care "
                        "about FOR THIS ARCHETYPE — entities, classifications, "
                        "quantities, sentiment/risk where relevant, key dates, "
                        "summaries. The schema must apply to every document "
                        "in the corpus (they all follow the archetype). Scale "
                        "precision with difficulty: at low difficulty prefer "
                        "flat, obvious fields; at high difficulty include "
                        "richer nested structures, enums, and arrays of "
                        "objects that demand careful inference."
                    )
                ),
            }
        ],
        output_format=GeneratedSchema,
    )
    return response.parsed_output


async def generate_prompt(
    client: anthropic.AsyncAnthropic,
    domain: str,
    schema: GeneratedSchema,
    difficulty: int = 5,
) -> GeneratedPrompt:
    p = difficulty_profile(difficulty)
    json_schema = schema_to_json_schema(schema)
    response = await client.messages.parse(
        model=PROMPT_MODEL,
        max_tokens=8000,
        system=(
            "You write production-grade extraction prompts. Your prompts are "
            "precise, constrained, and unambiguous about how to handle missing "
            "or low-confidence fields."
        ),
        messages=[
            {
                "role": "user",
                "content": (
                    f"Domain: {domain}\n"
                    f"Target difficulty: {p['difficulty']}/10 ({p['descriptor']}).\n\n"
                    f"Output JSON Schema (Draft 2020-12):\n```json\n{json_schema}\n```\n\n"
                    "Write a structured prompt that, when run against a single "
                    "document from this domain, will produce a JSON object "
                    "matching the schema. Calibrate the prompt's rigor and "
                    "guardrails to the difficulty: at low difficulty keep it "
                    "concise and trusting; at high difficulty add explicit "
                    "guidance for ambiguity, partial information, conflicting "
                    "cues, and nested-field inference. Your `user_template` "
                    "MUST contain the literal string '{{document}}' where the "
                    "document content will be substituted at runtime."
                ),
            }
        ],
        output_format=GeneratedPrompt,
    )
    return response.parsed_output


# --------------------------------------------------------------------------- #
# Orchestration helper used by the streaming endpoint
# --------------------------------------------------------------------------- #


async def gather_datasets_concurrently(
    client: anthropic.AsyncAnthropic,
    domain: str,
    archetype: str,
    instances: list[str],
    on_start,  # async callable: (idx, instance) -> None — fires before the API call
    on_complete,  # async callable: (idx, dataset) -> None — fires after each finishes
    difficulty: int = 5,
) -> list[GeneratedDataset]:
    """Run all DATASET_COUNT generations in parallel via asyncio.gather over
    AsyncAnthropic — each HTTP request flies out before any of the others
    finish. `on_start` fires for every dataset before its API call so a
    streaming UI can show the parallel kickoff.

    All datasets share the same archetype so the corpus is homogeneous."""
    results: list[GeneratedDataset | None] = [None] * DATASET_COUNT

    async def one(i: int, instance: str) -> None:
        await on_start(i + 1, instance)
        ds = await generate_dataset(
            client, domain, archetype, instance, i + 1, difficulty
        )
        results[i] = ds
        await on_complete(i + 1, ds)

    await asyncio.gather(*(one(i, t) for i, t in enumerate(instances)))
    return [r for r in results if r is not None]


# --------------------------------------------------------------------------- #
# Run the structured prompt against each dataset
# --------------------------------------------------------------------------- #


@dataclass
class RunResult:
    structured_output: dict[str, Any]
    tokens_in: int
    tokens_out: int
    latency_ms: int


def _render_user_template(template: str, document: str) -> str:
    if "{{document}}" in template:
        return template.replace("{{document}}", document)
    # Fallback: append the document if the template forgot the placeholder.
    return f"{template}\n\n<document>\n{document}\n</document>"


async def execute_prompt(
    client: anthropic.AsyncAnthropic,
    system_text: str,
    user_template: str,
    document: str,
    json_schema: dict[str, Any],
) -> RunResult:
    started = time.monotonic()
    response = await client.messages.create(
        model=RUN_MODEL,
        max_tokens=8000,
        system=system_text,
        messages=[
            {
                "role": "user",
                "content": _render_user_template(user_template, document),
            }
        ],
        output_config={
            "format": {
                "type": "json_schema",
                "schema": json_schema,
            }
        },
    )
    latency_ms = int((time.monotonic() - started) * 1000)
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Model returned non-JSON output: {e}") from e
    return RunResult(
        structured_output=parsed,
        tokens_in=response.usage.input_tokens,
        tokens_out=response.usage.output_tokens,
        latency_ms=latency_ms,
    )


async def gather_runs_concurrently(
    client: anthropic.AsyncAnthropic,
    system_text: str,
    user_template: str,
    json_schema: dict[str, Any],
    datasets: list[tuple[int, str, str]],  # (idx, dataset_id, content)
    on_complete,  # async callable: (idx, dataset_id, RunResult | Exception) -> None
) -> None:
    async def one(idx: int, dataset_id: str, content: str) -> None:
        try:
            result = await execute_prompt(
                client, system_text, user_template, content, json_schema
            )
            await on_complete(idx, dataset_id, result)
        except Exception as e:  # noqa: BLE001
            await on_complete(idx, dataset_id, e)


# --------------------------------------------------------------------------- #
# Anthropic Batch API — used by the deploy-friendly stateless runner
# --------------------------------------------------------------------------- #


# Output schema that matches GeneratedDataset (kept manually so the schema
# stays clean — Pydantic's auto-generated schema includes extras like
# `additionalProperties: true` and titles that confuse strict json_schema).
DATASET_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {
            "type": "string",
            "description": "Short, descriptive title (≤ 80 chars).",
        },
        "content": {
            "type": "string",
            "description": (
                "A realistic, substantive document in the domain. Use the "
                "kind of structure a real document would have."
            ),
        },
    },
    "required": ["title", "content"],
    "additionalProperties": False,
}


def _dataset_request_params(
    domain: str,
    archetype: str,
    instance: str,
    idx: int,
    difficulty: int,
) -> dict[str, Any]:
    """Messages-API params for one dataset generation, used both directly and
    via the Batch API. Uses `output_config.format` for schema-enforced JSON
    output; only `{type, schema}` is allowed (no `name`)."""
    p = difficulty_profile(difficulty)
    return {
        "model": DATASET_MODEL,
        "max_tokens": 8000,
        "system": (
            "You produce realistic, substantive sample documents for a "
            "structured-extraction testbed. Documents must read like real "
            "artifacts — not summaries, not meta-descriptions. Documents in "
            "a corpus share a single archetype — same format, same section "
            "structure, varying only in subject matter."
        ),
        "messages": [
            {
                "role": "user",
                "content": (
                    f"Domain: {domain}\n\n"
                    f"<archetype>\n{archetype}\n</archetype>\n\n"
                    f"<instance>\n{instance}\n</instance>\n\n"
                    f"Index: {idx}/10\n"
                    f"Target difficulty: {p['difficulty']}/10 ({p['descriptor']}).\n\n"
                    "Write a realistic document for this specific instance. "
                    "It MUST follow the archetype exactly — same sections, "
                    "same headings, same overall structure as the other 9 "
                    "documents in this corpus. Vary only the actual subject "
                    "matter and specific details. "
                    f"Length: roughly {p['word_lo']}–{p['word_hi']} words. "
                    "At low difficulty, keep facts explicit and well-"
                    "organised; at high difficulty, weave in ambiguity, "
                    "implicit cues, partial or conflicting information."
                ),
            }
        ],
        "output_config": {
            "format": {
                "type": "json_schema",
                "schema": DATASET_JSON_SCHEMA,
            }
        },
    }


def _run_request_params(
    system_text: str,
    user_template: str,
    document: str,
    json_schema: dict[str, Any],
) -> dict[str, Any]:
    """Messages-API params for one extraction run."""
    return {
        "model": RUN_MODEL,
        "max_tokens": 8000,
        "system": system_text,
        "messages": [
            {
                "role": "user",
                "content": _render_user_template(user_template, document),
            }
        ],
        "output_config": {
            "format": {
                "type": "json_schema",
                "schema": json_schema,
            }
        },
    }


async def submit_dataset_batch(
    client: anthropic.AsyncAnthropic,
    domain: str,
    archetype: str,
    instances: list[str],
    indices: list[int],   # only the indices to (re)generate
    difficulty: int,
) -> str:
    """Submit a batch of dataset generations. Returns the batch ID."""
    requests = [
        {
            "custom_id": f"dataset-{idx}",
            "params": _dataset_request_params(
                domain, archetype, instances[idx - 1], idx, difficulty
            ),
        }
        for idx in indices
    ]
    batch = await client.messages.batches.create(requests=requests)
    return batch.id


async def submit_run_batch(
    client: anthropic.AsyncAnthropic,
    system_text: str,
    user_template: str,
    json_schema: dict[str, Any],
    datasets: list[tuple[int, str, str]],   # (idx, dataset_id, content)
) -> str:
    """Submit a batch of prompt-against-dataset runs. Returns the batch ID."""
    requests = [
        {
            "custom_id": f"run-{idx}-{dataset_id}",
            "params": _run_request_params(
                system_text, user_template, content, json_schema
            ),
        }
        for (idx, dataset_id, content) in datasets
    ]
    batch = await client.messages.batches.create(requests=requests)
    return batch.id


async def batch_processing_status(
    client: anthropic.AsyncAnthropic, batch_id: str
) -> str:
    """`in_progress` | `ended` | `canceled` | `expired`."""
    batch = await client.messages.batches.retrieve(batch_id)
    return batch.processing_status


@dataclass
class BatchItemResult:
    custom_id: str
    parsed: dict[str, Any] | None
    tokens_in: int | None
    tokens_out: int | None
    error: str | None


def _strip_code_fences(text: str) -> str:
    """Strip ```json ... ``` or ``` ... ``` wrappers if present."""
    s = text.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s[3:]
        if s.endswith("```"):
            s = s[: -3]
        s = s.strip()
    return s


async def collect_batch_results(
    client: anthropic.AsyncAnthropic, batch_id: str
) -> list[BatchItemResult]:
    """Iterate the results stream and parse each succeeded message's first
    text block as JSON. Errors are returned as items with `error` set."""
    out: list[BatchItemResult] = []
    async for result in await client.messages.batches.results(batch_id):
        custom_id = result.custom_id
        if result.result.type == "succeeded":
            msg = result.result.message
            text = next((b.text for b in msg.content if b.type == "text"), "")
            text = _strip_code_fences(text)
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as e:
                out.append(
                    BatchItemResult(
                        custom_id=custom_id,
                        parsed=None,
                        tokens_in=msg.usage.input_tokens,
                        tokens_out=msg.usage.output_tokens,
                        error=f"non-JSON output: {e}",
                    )
                )
                continue
            out.append(
                BatchItemResult(
                    custom_id=custom_id,
                    parsed=parsed,
                    tokens_in=msg.usage.input_tokens,
                    tokens_out=msg.usage.output_tokens,
                    error=None,
                )
            )
        elif result.result.type == "errored":
            err = getattr(result.result, "error", None)
            msg = getattr(err, "message", None) or repr(err)
            out.append(
                BatchItemResult(
                    custom_id=custom_id,
                    parsed=None,
                    tokens_in=None,
                    tokens_out=None,
                    error=f"batch error: {msg}",
                )
            )
        else:
            out.append(
                BatchItemResult(
                    custom_id=custom_id,
                    parsed=None,
                    tokens_in=None,
                    tokens_out=None,
                    error=f"batch result type: {result.result.type}",
                )
            )
    return out

    await asyncio.gather(*(one(i, did, c) for i, did, c in datasets))
