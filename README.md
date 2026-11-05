# polyfork

Find a free low-poly 3D model and put it in your project.

```sh
npx polyfork search camper van
npx polyfork add pop-top-camper-van-62a322
```

```
Pop-Top Camper Van: saved public/models/pop-top-camper-van-62a322.glb (302 KB)
new GLTFLoader().load('/models/pop-top-camper-van-62a322.glb', (gltf) => scene.add(gltf.scene));
```

No install, no account and no key for a GLB. Works with three.js, Unity, Godot, Blender and anything else that reads glTF. Browse everything at [polyfork.dev](https://polyfork.dev/assets), or in the [public catalogue](https://github.com/lucas-martinic/polyfork-catalog).

## A model is a program

Many models are also code you can change with knobs. Get the source with a free account:

```sh
npx polyfork login
npx polyfork add pop-top-camper-van-62a322 --format mjs
```

```js
import { createAsset } from '/models/pop-top-camper-van-62a322.mjs';

scene.add(createAsset({ colorway: 'tomato', roof: 0, season: 'winter' }));
```

Each model's page lists its knobs.

## Commands

| Command | What it does |
|---|---|
| `polyfork search <words>` | Find models |
| `polyfork add <id or words>` | Put one model in your project |
| `polyfork kits [words]` | List themed kits |
| `polyfork add --kit <id>` | Put a whole kit in your project, as one zip (free account) |
| `polyfork login` | Connect a free account |
| `polyfork logout` | Forget it |

| Option | Meaning |
|---|---|
| `--format <f>` | `glb` (default), `mjs`, `fbx`, `usdz`, `usda`, `obj` |
| `--dir <path>` | Where to save. Default `public/models` if there is a `public` folder, otherwise `models` |
| `--first` | Take the best match instead of asking |
| `--force` | Replace a file that is already there |
| `--type <t>` | Search one type: `prop`, `building`, `vehicle`, `character`, `animal`... |
| `--limit <n>` | Search results, 1 to 50 (default 10) |
| `--json` | Machine-readable output |

## In scripts and agents

Nothing waits for a person. If a name matches more than one model, `add` lists the ids and stops, so search first and add by id, or pass `--first`. Use `--json` for structured output, and set `POLYFORK_KEY` instead of running `login`. You can also pipe a key in: `polyfork login < key.txt`.

| Exit code | Meaning |
|---|---|
| 0 | Done |
| 1 | Failed |
| 2 | Bad usage, or more than one match |
| 3 | Needs an account |

## Licence

This tool is MIT licensed. **The models are not**: they have their own [licence](https://polyfork.dev/licensing). They are free to use in personal and commercial projects, changed however you like, with no attribution. The free models' mesh files (GLB, FBX, USD, OBJ) are also [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), so you may share them as long as each keeps its credit line; the `.mjs` source and the HD editions may not be redistributed.
