# SLOT1's GTA model

SLOT1 trains its own GTA model from what happens in streams sent to SLOT1, **only from creators who opt in**. The loop is collect → label → freeze a dataset → train → evaluate → activate → run live → collect again. Each turn of the loop makes the model better at GTA, as long as people keep labeling.

```
uploads, clips, live ingest ──► shared observation pipeline ──► frame
     │                                     │
     │            consent on?  ──no──► nothing kept
     │                 │yes
     │                 ▼
     │        training_frames (+ files under the session)  ◄── automatic proposals
     │                 │                                      (on-screen text, measurements,
     │                 ▼                                       model guesses below threshold)
     │        Studio → GTA model → label (scene, events, boxes)
     │                 │
     │                 ▼
     │        dataset version (frozen, split by session) ──► export zip ──► ml/train_*.py on a GPU
     │                                                                           │
     ▼                                                                           ▼
 live log ◄── confident predictions ◄── worker (ONNX Runtime) ◄── activate ◄── registry (+ metrics)
```

## Consent

- **Off by default.** The setting is per channel: Studio → GTA model → "Use frames from my streams to train SLOT1's GTA model".
- **While it's on,** SLOT1 keeps one frame every 10 s of media from the creator's uploads, Twitch clips and live video sources. It also keeps frames at scene cuts and frames where on-screen text suggests something worth labeling, at most every 2 s. Each session is capped at 2,000 frames.
- **Consent is re-checked every 10 s** during live analysis, so switching it off stops collection almost immediately. Each frame records when consent was given (`consent_at`).
- **Revoking consent** removes the channel's frames from all **future** dataset versions. **Delete my training data** removes every frame and label right away.
- **Deleting a session,** or all data, deletes its training frames and their files. Training frames follow the channel's retention setting like other session media.
- **Copies already downloaded** in an exported dataset can't be recalled. The consent text says so.

## What the model learns (taxonomy v1)

The source of truth is `packages/contracts/src/gta-taxonomy.ts`.

- **Scenes (one per frame):** driving, on foot, shootout, cutscene, menu or map, loading or black, phone, other.
- **Events (any number):** mission passed or failed, wasted, busted, wanted level up or cleared, police chase, vehicle crash, money change, getting in or out of a vehicle.
- **Boxes:** minimap, wanted stars, money, health and armor, mission text, subtitle, big message (MISSION PASSED, WASTED…), weapon, phone, vehicle, person.

Changing the classes means bumping `GTA_TAXONOMY_VERSION`. Datasets and models record their version, and models of another version are never activated or run.

## Labeling

Studio → GTA model → **Label frames** shows the creator's own frames, with suggestions first.

**Keyboard:**
- keys 1–8 pick the scene
- Enter saves
- S skips
- Esc cancels a box being drawn

**Suggestions** come from several sources:
- on-screen text: "MISSION PASSED" suggests the event plus a big-message box; a `$12,450` line suggests a money box; a speaker line suggests a subtitle box; "Lose the cops" suggests a police chase
- measurements: a black segment suggests the "loading or black" scene
- the active model's own guesses

Dashed boxes are suggestions; **Accept** turns one into a real box. When a person saves:
- their answer replaces earlier human labels
- suggestions that agree are marked accepted
- the rest are rejected

Only human-accepted labels enter datasets.

## Datasets, training and activation (operators)

These steps are deployment-wide and limited to SLOT1 operators; for anyone else the endpoints return 404.

1. **Build dataset version.** All labeled frames from channels that currently consent go in.
   - Split by session: 75% train, 10% val, 15% test, with a fixed seed. No stream appears in two splits, and the test set only grows.
   - The sha256 of the test frame ids identifies the test split.
2. **Export the zip** and train on a GPU with `ml/train_scene.py` and `ml/train_detector.py` (see [ml/README.md](../ml/README.md)).
   - A rented cloud GPU is the practical choice; hours of footage train in minutes to hours, not days.
3. **Upload model:** the `.onnx` plus the metadata JSON the script wrote. Every evaluation must name a real dataset version and its exact test split hash, otherwise the upload is refused.
4. **Activate.** A candidate replaces the active model only if, on the **same** test split, its primary metric is at least as good: macro-F1 for scenes, mAP@0.5 for boxes. If the two were never evaluated on the same split, activation is refused. In that case, run `ml/eval.py` for both on the newest dataset and add the evaluations.

## Running live

The worker loads the active scene and detector models with ONNX Runtime (CPU by default) and verifies each file's sha256 against the registry. It runs them on every sampled frame of uploads, clips and live ingest. Both smoke-test models together took about 40 ms per frame on the 2-core cloud CPU used here, so they keep up with live sampling.

Publishing rules match the rest of SLOT1:

- **Thresholds:** only predictions at or above them publish. The defaults are 0.6 for scenes and events and 0.5 for boxes; scores are labeled "model reports", never "accuracy".
- **Visible events:** scenes and on-screen results (MISSION PASSED, WASTED…) are *directly visible* and cite their frame.
- **Events over time** (chases, crashes, wanted-level changes) need two consecutive frames, are labeled *inferred*, and cite both frames.
- **Below threshold:** nothing is published. Those predictions go to the labeling queue, least certain first.
- **Attribution:** observations are attributed to `slot1-gta` and the model version, so every line in the log can be traced to the model that produced it.

## Realistic expectations

- **The machinery works end to end.** It was tested here with synthetic color-bar footage: a tiny CPU training run, ONNX export verified against PyTorch, registry upload, activation rule, and live inference on new footage producing proposals.
- **That model knows nothing about GTA.** A useful GTA model needs many hours of real gameplay, thousands of carefully labeled frames covering every scene, event and HUD element, and GPU training. Quality is roughly bounded by labeling volume and consistency.
- **Start small.** Scenes and big result screens are the easiest to learn, HUD boxes come next, and events over time are hardest.
- **Evaluate before switching.** The activation rule stops a worse model from replacing a better one, but it can't make up for a test set that's too small. Watch the per-class numbers.

## Rights

Gameplay footage is Rockstar Games / Take-Two content, and streams belong to their creators. Before training on gameplay footage or using a trained model commercially:

- Check Rockstar/Take-Two's current terms for videos and other uses of game footage.
- Make sure every contributing creator has opted in, which SLOT1 enforces.

This isn't legal advice.
