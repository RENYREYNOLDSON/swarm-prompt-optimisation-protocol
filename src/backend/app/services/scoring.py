"""Deterministic structural scoring of a predicted JSON object against a gold
object, weighted by a JSON Schema. Returns a score in [0, 1].

Required fields contribute weight 1.0; optional fields 0.5. Missing required
fields score 0; missing optional fields are skipped (no weight contribution).

Per-leaf rules are documented in `_score_leaf` below — see also the README's
"How the swarm works → Scoring" section.
"""
from __future__ import annotations

import re
from typing import Any


_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _normalise_string(s: Any) -> str:
    if s is None:
        return ""
    return str(s).strip().lower()


def _tokens(s: Any) -> set[str]:
    return set(_TOKEN_RE.findall(_normalise_string(s)))


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _f1_multiset(predicted: list[Any], gold: list[Any]) -> float:
    """Token-level F1 over multisets of normalised string elements."""
    p = [_normalise_string(x) for x in predicted]
    g = [_normalise_string(x) for x in gold]
    if not p and not g:
        return 1.0
    if not p or not g:
        return 0.0
    # Multiset intersection
    p_counts: dict[str, int] = {}
    for v in p:
        p_counts[v] = p_counts.get(v, 0) + 1
    g_counts: dict[str, int] = {}
    for v in g:
        g_counts[v] = g_counts.get(v, 0) + 1
    overlap = sum(min(p_counts.get(k, 0), g_counts[k]) for k in g_counts)
    if overlap == 0:
        return 0.0
    precision = overlap / len(p)
    recall = overlap / len(g)
    return 2 * precision * recall / (precision + recall)


def _score_number(predicted: Any, gold: Any) -> float:
    try:
        p = float(predicted)
        g = float(gold)
    except (TypeError, ValueError):
        return 0.0
    if g == 0:
        return 1.0 if p == 0 else 0.0
    rel = abs(p - g) / abs(g)
    if rel <= 0.01:
        return 1.0
    if rel <= 0.05:
        return 0.7
    if rel <= 0.20:
        return 0.3
    return 0.0


def _best_match_array_of_objects(
    predicted: list[Any],
    gold: list[Any],
    item_schema: dict[str, Any],
) -> float:
    """Greedy best-match alignment: for each gold item, find the predicted
    item with the highest pairwise score (without replacement)."""
    if not predicted and not gold:
        return 1.0
    if not gold:
        return 0.0  # extra predictions but nothing to match
    used = [False] * len(predicted)
    total = 0.0
    for g in gold:
        if not isinstance(g, dict):
            continue
        best = 0.0
        best_idx = -1
        for i, p in enumerate(predicted):
            if used[i] or not isinstance(p, dict):
                continue
            s = _score_object(p, g, item_schema)
            if s > best:
                best = s
                best_idx = i
        if best_idx >= 0:
            used[best_idx] = True
        total += best
    # Penalty for unmatched-extra predicted items? Skip for v1 — keeps
    # scores lenient and avoids punishing ambitious extractions.
    return total / len(gold)


def _score_object(
    predicted: dict[str, Any],
    gold: dict[str, Any],
    schema: dict[str, Any],
) -> float:
    properties: dict[str, Any] = schema.get("properties") or {}
    required: set[str] = set(schema.get("required") or [])
    if not properties:
        return 1.0 if predicted == gold else 0.0
    weighted_sum = 0.0
    weight_total = 0.0
    for field_name, field_schema in properties.items():
        is_required = field_name in required
        weight = 1.0 if is_required else 0.5
        gold_value = gold.get(field_name) if isinstance(gold, dict) else None
        pred_value = (
            predicted.get(field_name) if isinstance(predicted, dict) else None
        )
        if gold_value is None:
            # If the gold doesn't have this field, don't grade it.
            continue
        if pred_value is None:
            # Missing required → 0 with weight; missing optional → skip.
            if is_required:
                weighted_sum += 0.0
                weight_total += weight
            continue
        leaf = _score_leaf(pred_value, gold_value, field_schema)
        weighted_sum += weight * leaf
        weight_total += weight
    if weight_total == 0:
        return 1.0
    return weighted_sum / weight_total


def _score_leaf(
    predicted: Any,
    gold: Any,
    schema: dict[str, Any],
) -> float:
    """Score a single field by its JSON Schema description."""
    s_type = schema.get("type")

    # Enums (strings with `enum`) — exact match only.
    if "enum" in schema:
        return 1.0 if _normalise_string(predicted) == _normalise_string(gold) else 0.0

    if s_type == "string":
        if _normalise_string(predicted) == _normalise_string(gold):
            return 1.0
        return _jaccard(_tokens(predicted), _tokens(gold))

    if s_type == "boolean":
        return 1.0 if bool(predicted) == bool(gold) else 0.0

    if s_type in ("integer", "number"):
        return _score_number(predicted, gold)

    if s_type == "array":
        items_schema = schema.get("items") or {}
        if not isinstance(predicted, list) or not isinstance(gold, list):
            return 0.0
        if items_schema.get("type") == "object":
            return _best_match_array_of_objects(predicted, gold, items_schema)
        return _f1_multiset(predicted, gold)

    if s_type == "object":
        if not isinstance(predicted, dict) or not isinstance(gold, dict):
            return 0.0
        return _score_object(predicted, gold, schema)

    # Unknown / missing type → fallback to coarse equality.
    return 1.0 if predicted == gold else 0.0


def score_against_gold(
    predicted: dict[str, Any],
    gold: dict[str, Any],
    json_schema: dict[str, Any],
) -> float:
    """Score a predicted object against a gold object using a JSON Schema.

    Returns a value in [0, 1]. The schema is the project's extraction schema
    (Draft-2020-12 shape with top-level "properties" / "required").
    """
    if not isinstance(predicted, dict):
        return 0.0
    score = _score_object(predicted, gold, json_schema)
    # Clamp defensively.
    return max(0.0, min(1.0, score))
