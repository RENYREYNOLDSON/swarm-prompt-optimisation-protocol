import { Markdown } from '@/components/markdown'

const GUIDE_MD = `
# Guide

SPOP (Swarm Prompt Optimisation Protocol) generates accurate
structured-extraction prompts for your domain by running a small ant
colony of LLM agents that reverse-engineer the prompt from
\`(document, expected_output)\` pairs.

## Getting started

1. **Create a project** — give it a name, a one-paragraph description
   of the domain, and a difficulty (1–10).
2. **Wait for setup** — SPOP picks a document archetype, generates 10
   sample documents in parallel, drafts a JSON Schema with at least
   10 fields (some nested), writes a baseline extraction prompt, and
   runs that prompt against every dataset to produce gold outputs.
3. **Open the Playground tab** — click **New run**, configure the
   swarm, and click the run card to open the live ant farm. Press
   **Start**, watch agents climb the score.
4. **Pause when satisfied** — when the best score plateaus, click
   **Pause** and read off the reverse-engineered prompt.

## How the swarm works

The Playground runs an Ant-Colony Optimisation (ACO) loop that
*reverse-engineers* a structured-extraction prompt for the project.

### Setup

For each project, the generation pipeline already produced 10 documents
and a "gold" structured output for each. We split:

- **Training pool** — datasets 1..9 (documents + gold outputs the
  agents are allowed to see)
- **Held-out test** — dataset 10 (used only to score candidate prompts)

### One turn

Each turn fires \`K\` agents in parallel (\`K = config.num_agents\`).
For each agent \`a\`:

1. **Select a parent** prompt from the pool of completed attempts. With
   probability ε (the **Randomness** slider) pick uniformly at random;
   otherwise sample weighted by pheromone τ. On turn 1 the pool is
   empty and the parent is None.
2. **Sample 3 training pairs** \`(document, gold_output)\` uniformly
   at random from datasets 1–9.
3. **Draft a candidate prompt** by asking the agent LLM (the model
   chosen in the run config) to reverse-engineer a system + user
   template that maps each document to its gold output. If a parent
   was selected, it is shown as a seed to mutate.
4. **Execute** the candidate on the held-out test document (#10),
   producing a predicted output.
5. **Score** the prediction against the gold using the project's
   JSON Schema (see *Scoring* below) → s ∈ [0, 1].
6. **Deposit pheromone** \`Q · s\` on the new attempt, where Q is the
   **Pheromone strength** slider.

After all agents complete the turn:

7. **Evaporate** every attempt's pheromone by ρ = clamp(1 − Q,
   [0.05, 0.5]).
8. **Update best**: if any attempt beat the previous best score, it
   becomes the new champion in the **Best prompt** panel.

### Scoring

Given a predicted object, a gold object, and the JSON Schema, the
score is a required-weighted recursive average over fields. Each leaf
field contributes:

- **string**: 1 if normalised exact, else Jaccard similarity over word
  tokens
- **string_enum**, **boolean**: exact match → 1, else 0
- **integer**, **number**: 1 within 1%, 0.7 within 5%, 0.3 within 20%,
  else 0
- **array of scalars**: F1 over the multiset of normalised values
- **array of objects**: greedy best-match alignment, average per-pair
  score
- **object**: recurse
- **missing required**: 0; **missing optional**: skipped

Required fields contribute weight 1.0; optional fields 0.5. Scoring
is deterministic and runs locally — no LLM judge.

### Convergence intuition

High-scoring prompts get more pheromone and are sampled more often
as parents next turn. Mutations of those parents get scored, and
good ones in turn earn more pheromone. Evaporation prevents the
pool from collapsing to a single strain too early. The exploration
rate ε keeps a steady stream of random parents in play so the swarm
can escape local maxima. In practice the **Best score** climbs
quickly, then plateaus — that's your cue to **Pause** and read off
the reverse-engineered prompt.

### Knobs (from the New Run dialog)

| Param | Effect |
|---|---|
| **Number of agents** K | More agents → more candidates per turn (higher cost, faster convergence). |
| **Randomness** ε | 0 = pure exploitation, 1 = pure exploration. |
| **Pheromone strength** Q | Deposit gain. Also drives evaporation ρ = 1 − Q (clamped to [0.05, 0.5]). |
| **Thought level** | Maps to extended-thinking budget on the agent LLM call (minimal/standard/deep/extreme → 0 / 2k / 8k / 20k tokens). |
| **AI model** | Which Claude model the agent uses to draft prompts. |

### Visualisation — the ant farm

To make the swarm spatial, every drafted prompt is mapped to a 2D
point. We embed the prompt with Voyage AI (or a deterministic local
hash-trick fallback if no API key) and project to 2D with
incremental PCA — deterministic and stable so dots don't jump around
as the run progresses.

On the map:

- **dot position** = the prompt's PCA-projected embedding
- **dot radius** ∝ pheromone (the colony's confidence in that strain)
- **dot colour** = HSL red → yellow → green keyed on score
- **trail opacity** = score of the child (faint for poor children,
  vivid for good ones)
- **agent ticker** beneath the map shows each agent's status
  (drafting → scoring → done); the resulting attempt lands as a new
  dot when the score arrives

As the swarm runs you should see clusters of green dots forming
around high-scoring strains, with thinning trails between them —
the colony's collective memory of which prompt regions were worth
exploring.

## Tips

- **Difficulty** on a project controls the size and ambiguity of the
  generated documents and schema. Start at 5 and dial up once the
  pipeline feels comfortable.
- **Higher Randomness** is useful early to avoid premature
  convergence; you can drop it later in a new run to refine around
  the best strain.
- **Higher Pheromone strength** makes the colony commit to good
  strains faster (lower evaporation) — good once you've found a
  promising region; risky early.
- **Thought level = deep / extreme** on the agent model produces
  noticeably better candidate prompts but slows turns considerably
  and costs more tokens.
- The Playground only works once a project has datasets, a prompt,
  and runs. If a project is still **Generating**, wait for it to
  reach **Ready**.
`

export default function Guide() {
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <Markdown className="text-sm">{GUIDE_MD}</Markdown>
    </div>
  )
}
