# Slune, reverse engineered and remade for the browser

[Slune](http://home.gna.org/oomadness/en/slune/) is a 3D racing and car-crashing game for Linux,
written in 2002–2008 by Jean-Baptiste "Jiba" Lamy in Python on his own Soya3D engine.
It needs Python 2, Pyrex-compiled Soya, SDL, OpenAL and GLEW, so it no longer runs on modern systems.

This folder holds:

| Path | What it is |
| --- | --- |
| `tools/soyapickle.py` | Loads Slune/Soya `.data` files (Python 2 pickles) without Soya, by stubbing every class |
| `tools/soyadecode.py` | Decoders for Soya's binary C-state blobs: World, Terrain, Model / CellShading / Tree models, Material, Image, Light, Atmosphere, Sprite |
| `tools/export_assets.py` | Converts the original data into JSON + PNG for the web build |
| `tools/fetch_original.sh` | Downloads Slune 1.0.14 + Soya 0.12 from archive.debian.org and re-runs the export |
| `tools/serve.py` | Local web server for `web/` with caching disabled |
| `web/` | The remake: three.js renderer, ports of Slune's physics, AI and race rules, all 14 race tracks and the 15-mission campaign |
| `web/js/campaign.js` | The campaign: `videosequence.py` (cut-scenes and mission logic) and the scripts embedded in the mission levels |
| `web/js/modes.js` | Modes the missions use: `hunt.py`, `fight.py`, `freestyle.py`, `medoc.py`, `airplane.py`, `arena.py` |
| `web/js/camera.js` | `soya.TravelingCamera` with its traveling stack (third-person and fixed shots) |
| `web/js/extras.js` | The other modes: `bowling.py`, the fight duel, `arena.py` deathmatches, trunk shooting, the Ride Park time trial |

## Run it

```bash
python3 tools/serve.py
```

Then open http://localhost:8765. You need a local server because the game fetches its JSON assets.
The **Campaign** tab plays the story missions, **Single race** plays any of the 14 tracks, and
**Other modes** has bowling, a duel, two deathmatch arenas, trunk shooting and a time trial.
During cut-scenes, click or press a key to continue.

**Controls.** The mouse works as in the original: the pointer steers, height on screen sets throttle, and holding
it at the bottom edge engages reverse. Left button jumps (pitches up while airborne), right button fires nitro or
the flame-thrower, and the middle button wall-climbs. **Keyboard:** arrows or WASD, Space to jump, Shift to wall-climb,
X or Alt for nitro, Esc to pause.

## What was reverse engineered

### `.data` file format
Every `.data` file in `worlds/`, `shapes/` and `materials/` is a **Python 2 pickle (protocol 1)**.
Soya objects pickle through `__reduce__` as `soya._soya._reconstructor(cls)` (older files use the module name `soyapyrex`),
followed by a state tuple `(cstate, __dict__)`. `cstate` is a **big-endian binary chunk** written by
`chunk_add_*_endian_safe` in Soya's C code, which is opaque to Python. Cross-file references are pickled as
`soya._loader(Class, name)`.

The C-state layouts were recovered from Soya 0.12's `__getcstate__` methods and checked byte-exactly:
all 44 shapes and 132 materials decode with **zero trailing bytes**.

| Class | C-state layout |
| --- | --- |
| CoordSyst / Body / World | `int option; float matrix[19]` (4×4 column-major plus 3 scale factors); World adds `(model, filename, children, atmosphere, model_builder[, data])` |
| Terrain (`Land`) | `option, matrix[19], nb_w, nb_d, patch_size, texture_factor, scale_factor, split_factor, nb_colors, [colors, vertex_colors], [vertex_options bytes], then per vertex (float height, int material_index)` |
| Model (Simple / CellShading / Tree) | `option, nb_vertices, nb_coords, nb_vnormals, nb_colors, nb_values, nb_faces; coords, vnormals, colors, values; vertex→coord/texcoord/diffuse offsets; [sphere]; faces (option, material, normal offset, v[4]); [neighbors]` |
| CellShadingModel | `(model_state, (outline_width, outline_attenuation, outline_color[4]), shader_material)` |
| Material | `option, shininess, diffuse[4], specular[4], emissive[4]` plus filename and embedded Image |
| Image | `nb_color, width, height, raw pixels` (top row first) |
| Light, Atmosphere, SkyAtmosphere, Sprite/Bonus | see `soyadecode.py` |

Points that mattered while decoding:
- Vertex → coord and texcoord indices are **float offsets**, not element indices.
- Terrain quads alternate their diagonal by `(x ^ z) & 1`. A triangle is hidden or non-solid only when **all three**
  of its vertices carry the flag. Getting this wrong opens holes beside the Cyberbombay tunnel.
- `ATMOSPHERE_FOG` is bit 3 and `FACE_SMOOTH_LIT` is bit 6. Smooth faces take normals from `vnormals[coord_offset]`;
  flat faces take them from `values[face.normal]`.
- Soya's `turn_*` rotates about the **object's own** axis, while `rotate_*` rotates about the **parent's** axis.

### Levels
A race level is a pickled `slune.level.Level` (a World) containing a `_loader` reference to its world file,
`slune.race.Flag` checkpoints (ordered by name `flag_N`), `LifeBonus` / `FlameThrowerBonus` sprites, `Pushable`
props, and `TakeableVehicle`s. Start positions live in an embedded Python script (`init_character_script`).
The exporter reads them with a small arithmetic-only evaluator, so none of the original code is executed.

### Game logic ported
- `character.Character.begin_action`: per-round (30 ms) vehicle physics. Local speed comes from the mouse
  (`x = mouse_x/120`, `z = (mouse_y·0.2 − 0.2)`). It covers force decay (×0.95), gravity (−0.03), hover height,
  ground alignment, jump and pitch, nitro (which costs life), axis-aligned wall raycasts with reflection, the
  crash-damage formula, and pushing.
- `Pushable.begin_round`: barriers, tree trunks and balls; destroyed props may drop bonuses (15% each).
- `controler.goto` / `Wall_climber` / `AttackRun` and `race.Opponent.IAControler`, including the tuned constants and
  per-character "chromosomes", rubber-banding and bonus hunting.
- `race.Checker` (flags, laps, ranking), `LifeBonus`, `FlameThrowerBonus`, flame-thrower damage cone, vehicle swap.
- `KeyboardMouseControler` input model and the HUD: life bar, laps label, minimap with character heads, and the
  next-flag edge arrow.
- `soya.ThirdPersonTraveling`, approximated as a chase camera that moves 30% per round and shortens on obstruction.

### The campaign
The 15 missions follow Tux, Gnu, Shark and Python smuggling medicine to Africa in 2003. Each mission level
(`level-mission-N.data`) holds a start script, Python code in `SphericalScript` trigger spheres, and named props.
The story itself is `videosequence.py` (about 2,800 lines), and the remake keeps its structure:
- A **video sequence** is a generator run once per role (`tux`, `gnu`, `shark`, `killer1`…) on that character's
  controller stack, with the roles sharing the sequence object. `PLAYER` and `AUTO` role values resolve as in
  `VideoSequence._start`. While a sequence runs on Tux, the player has no control and black bands show.
- `Pause()` makes every controller wait until a click (or a round count). `Fade()` is the 40-round `Fader`.
  Messages, camera speed and the **traveling stack** (`add_traveling` / `remove_traveling` / `zap`) behave as in the idler.
- Each mission's embedded scripts are hand-translated, including start grids, forced vehicles, trigger-sphere code
  by index, named objects such as `palace_door` (which becomes a moving collider), secret passages and props.
- The modes are ported too:
  - **Hunt:** `Praise` path-follower, `PathComputer` random routes, escape check.
  - **Fight:** `Fighter` strategy picker and chromosomes, `Mission6Killer`, `Mission7Pusher`, `AlienBoss`.
  - **Freestyle:** stunt recognition and scoring, score and timer labels.
  - **Medicine:** the `medoc` pickups and the giraffes waiting for medicine.
  - **Airplanes:** the `Airplane` moving platform, `FlyingAirplane` and `KillerAirplane`.
  - **Arena:** the arena minimap.

All 15 missions were checked in a headless harness: each intro plays through, and each mission reaches
"Level completed!" by its intended win condition.

| # | Mission | Where | Goal |
| --- | --- | --- | --- |
| 1 | The big truck | Crashfunkel | Drive the truck to Gnu, guided by his phone calls |
| 2 | Tailing Shark | Crashfunkel | Follow Shark through town without losing him |
| 3 | The palace door | Crashfunkel | Score stunts until the palace door opens, then take the secret passage |
| 4 | Mountain chase | At the Mountain | Chase Shark to his meeting |
| 5 | Assassins in the night | At the Mountain (night) | Escape the assassins back to the gate |
| 6 | Escape from the palace | Crashfunkel (night) | Sneak to the secret passage; stay off the ground near the guards |
| 7 | Python's hut | Indus Meeting | Reach Python's hut past falling tree trunks |
| 8 | Race to the laboratory | Cyberbombay | Stop both assassins before they reach the lab |
| 9 | Strike! | Bombay bowling | Push the assassin into the pins within five seconds |
| 10 | Scattered medicine | Urban Call | Collect the spilled medicine in time |
| 11 | Catch the plane | Airport | Land on the airliner's roof before it takes off |
| 12 | Flight to Africa | On the plane | Survive the assassins on the flying plane's roof |
| 13 | Lost in the desert | Desertic Sorry | Score enough stunts to be rescued |
| 14 | Medicine for the village | Chapakalake | Deliver medicine to every hut while a plane tries to crush you |
| 15 | Shark's true face | Ride Park | Defeat the alien boss |

### Other modes
| Mode | Level | Rules (from the original) |
| --- | --- | --- |
| Bowling 1–3 | `level-bowling-N` | Push the ball into the pins. You get 3 − difficulty extra balls and are driven back behind the line between balls. Crossing z < −15 loses. Clearing the pins with the first ball is a strike. |
| Duel | `level-crashfunkel-duel` | You against one `Fighter`. The last one standing wins. |
| Arena ×2 | `level-cyberbombay-arena-1`, `level-urbancall-arena-1` | Deathmatch with `arena.Opponent` fighters. A death credits a frag to whoever last pushed you, then you respawn at the next start point with 2.0 life. The first to the frag target wins. |
| Trunk shoot | `level-indusmeeting-shoot-1` | "Bring down the ball by throwing trunks!" Nitro is disabled. |
| Time trial | `level-ridepark-clock-1` | One lap of the Ride Park flags on the scooter, against a 1000 / 200 / 100 s limit. |

## Where the remake deviates (design choices)
- **Start grid:** the original spaces racers 2 units apart at a single height. Wide vehicles overlap and push each
  other into the air, and on sloped starts a slot can be underground. The remake spreads overlapping slots and
  drops each racer onto the ground.
- **Push impulse capped at 1.5** to stop feedback between overlapping vehicles.
- **Kill height** is −35 as in the original, or 8 units below the lowest geometry if the world goes deeper.
- **Steering lean** is clamped (the original's net roll at full lock is ±50°).
- Rendering is three.js: toon shading with inverted-hull outlines instead of Soya's cell-shading pass, a gradient
  sky dome, and an optional longer view distance (the original clips at the fog end).
- Additions: a lap timer, race position, results screens, campaign progress saved in the browser, and a
  "click to continue" hint during pauses.
- **Campaign details:**
  - **Timers:** mission timers count game time (pauses excluded) rather than wall-clock time, and stop once a
    mission is won or lost.
  - **Auto-continue pauses:** a `Pause(n)` lasts n rounds. The original counted down once per character per round.
  - **Fighter chromosomes:** they mutate a copy rather than the shared table.
  - **Mission 7 camera:** after the hut cut-scene the camera speed goes back to normal (the original left it slow).
  - **Killer airplane:** it is not a solid collider.
- **Missions are all selectable,** as in the original (whose unlock filter in `gui_gl.py` is commented out).
  Finished missions are ticked.
- **Trunk shoot** has no ending in the original. The remake ends it when the ball falls.
- **Arena and opponent counts:** the original's "opponents" setting counted the player. In the remake it is the
  number of computer players. The "laps" setting doubles as the frag target, as `RACE_NB_LAPS` did.
- Not ported: network play (the `tofu` / `py2play` multiplayer layer and its demo level), and `ACTION_ROTLAT`
  (it has no key binding in the original either). Freestyle has no standalone level in the original; it exists only
  inside Missions 3 and 13.

## Licence
Slune and Soya3D are GPL (version 2 or later). The data in `web/assets` comes from Slune 1.0.14, and the code in
`web/js` ports Slune's logic, so this remake is distributed under the same GPL-2.0-or-later terms.
