# ⚯ Genesis Engine

**An open-ended artificial-life substrate that runs entirely in your browser.**

Genesis Engine is a tiny universe whose only hand-written rules are physics. Creatures, species, predators, and replicators are meant to *emerge* — not to be programmed in. It runs 100% client-side on your GPU via WebGL2; there is no server and no build step.

▶ **Live: https://teknium1.github.io/genesis-engine/**

![Genesis Engine](assets/preview.png)

---

## Why this exists

This project started from Emergent Garden's video [*Artificial Life*](https://www.youtube.com/watch?v=2g-CrQfYNtE) and the question it keeps circling: **why does virtual life always stall?** Cellular automata and evolution simulators reliably fill their world, converge to something simple and boring, and stop surprising you. Real biology complexified for four billion years. As the video puts it: *"We are missing something, and no one really knows what that something is."*

The 2022–2026 artificial-life literature has converged on a handful of concrete answers — but they live in **separate** systems, each attacking the stall problem from one angle. Genesis Engine's contribution is to fuse the four most load-bearing ideas into a **single browser-runnable substrate**, so they can reinforce each other in one world:

| Ingredient | What it fixes | Source |
|---|---|---|
| **Mass conservation** — matter flows, never minted from nothing | Kills the "grow → fill the world → freeze into a dead crystal" failure mode; forces genuine competition over a finite matter budget | [Flow-Lenia](https://arxiv.org/abs/2212.07906) (Plantec, Hamon, Etcheverry, Chan, Oudeyer, Moulin-Frier, 2023 / *Artificial Life* 31(2), 2025) |
| **Embedded genome (parameter localization)** — each creature's update-rule parameters live *inside* the medium and flow with its matter | Lets the genome truly mutate *intrinsically*, and lets many species share **one** world (classic Lenia creatures each need their own universe) | Flow-Lenia (same) |
| **Metabolic energy economy** — a light field becomes energy; energy pays upkeep and reproduction | Scarcity carves out ecological niches (producers/consumers), the video's hypothesized missing "energy/metabolism" building block | [Biomaker CA](https://arxiv.org/abs/2307.09320) (Randazzo & Mordvintsev, 2023) |
| **Novelty drive** — the world watches its own feature-space trajectory and stirs the medium when it stagnates | Directly attacks convergence: an anti-stall pressure toward sustained novelty | Adapted from [ASAL](https://arxiv.org/abs/2412.17799) (Kumar, Lu, Kirsch, Tang, Stanley, Isola, Ha — Sakana AI, 2024/2025) |

Plus the video's own field heuristic, baked into the UI: **"be on the lookout for worms."** A live detector counts worm/replicator-like structures, because where there are worms, replicators are usually hiding nearby.

### On the novelty drive

ASAL uses a vision-language foundation model to score how "interesting" a simulation stays over time and to steer search toward open-ended novelty. Shipping an FM to a static page isn't possible, so Genesis Engine **adapts** the idea rather than porting it: it computes a cheap 7-dimensional feature vector describing the whole world each measurement (mean/variance of mass, energy, genome, activity, occupancy) and tracks how much that vector keeps changing. Sustained change = still surprising. A collapse toward zero = stalled → the engine raises a "curiosity" signal that perturbs the medium with fresh matter and fresh genomes. It is a lightweight, local stand-in for ASAL's learned interestingness measure, in the same spirit.

---

## How it works (technical)

The entire simulation is a ping-pong of WebGL2 fragment-shader passes over RGBA **float** textures. Each cell packs four channels:

```
R = mass      (the "stuff" a creature is made of; conserved when enabled)
G = energy    (metabolic charge from the light field)
B = genome μ  (LOCAL growth-kernel center — the embedded gene)
A = genome σ  (LOCAL growth-kernel width  — the second embedded gene)
```

Each step runs two GPU passes:

1. **Potential + flow** — convolve mass with a smooth Lenia ring kernel to get a potential `U`, evaluate each cell's *local-genome* growth response `2·bump(U, μ, σ) − 1`, and take the gradient of the resulting affinity field to get a flow vector.
2. **Integrate** — advect mass **and its genome** upstream along the flow (semi-Lagrangian, so mass is conserved rather than minted), apply the metabolic energy balance, mutate the local genome slightly, and inject curiosity sparks when the CPU-side novelty drive fires.

μ and σ travel *with* the matter, which is what makes the genome evolvable in-place and lets different rules coexist and mix at boundaries — the intrinsic multi-species evolution Flow-Lenia argued for.

### Files

```
index.html            UI shell + controls + help
style.css             dark theme
js/main.js            controller: loop, metrics cadence, poke, snapshot, URL state
js/engine.js          WebGL2 setup, ping-pong float textures, passes, readback
js/shaders/glsl.js    all GLSL (flow pass, integrate pass, render pass)
js/metrics.js         ASAL-inspired novelty drive + "worm" detector
js/worlds.js          seed presets (primordial, orbium, multispecies, scarcity, worms)
```

No dependencies, no bundler. Everything is native ES modules.

---

## Running locally

```bash
git clone https://github.com/teknium1/genesis-engine.git
cd genesis-engine
python3 -m http.server 8099    # or any static server
# open http://127.0.0.1:8099
```

A hardware GPU is strongly recommended — the whole sim runs on it. Requires a browser with **WebGL2** + `EXT_color_buffer_float` (recent Chrome, Firefox, Edge, Safari).

## Controls

- **Space** pause · **R** re-seed
- **Drag** to pan · **scroll** to zoom (toward the cursor) · **Reset view** to recenter
- **Shift+click** to inject matter · **Alt+click** to erase
- Toggle each ingredient independently to see what it contributes to (or subtracts from) the dynamics
- **Copy world link** encodes every knob in the URL so a world is shareable

### A note on honesty

Getting *spontaneous, sustained, open-ended* life out of random initial
conditions is the actual unsolved problem this whole field is about — every
known system either dies out or freezes into something static. Genesis Engine
does not claim to have solved it. What it does: build on **Lenia**, a substrate
that reliably produces living, *moving* creatures (start with the glider
presets — the Orbium glider genuinely swims and collides), then let you layer
on the four research ingredients and watch what each one does to the dynamics.
The **Primordial soup** preset is the honest case: watch it self-organize and,
usually, freeze. That freeze *is* the phenomenon the video is about.

---

## Further reading

- Bert Chan — [Lenia: Biology of Artificial Life](https://arxiv.org/abs/1812.05433) · [Lenia portal](https://chakazul.github.io/lenia.html)
- Plantec et al. — [Flow-Lenia](https://arxiv.org/abs/2212.07906)
- Randazzo & Mordvintsev — [Biomaker CA](https://arxiv.org/abs/2307.09320) · [Growing Neural Cellular Automata](https://distill.pub/2020/growing-ca/) · [Particle Lenia](https://google-research.github.io/self-organising-systems/particle-lenia/)
- Kumar et al. (Sakana AI) — [Automating the Search for Artificial Life with Foundation Models (ASAL)](https://arxiv.org/abs/2412.17799)
- Hartl et al. — [Neural cellular automata: applications to biology and beyond](https://www.sciencedirect.com/science/article/abs/pii/S1571064525001757) (2025)
- [ALife Survey 2024–2026](https://github.com/ochyai/alife-survey-2025) · [International Society for Artificial Life](https://alife.org/)

## License

MIT — see [LICENSE](LICENSE).
