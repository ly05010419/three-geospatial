# three-geospatial — WebGPU Clouds Fork

This fork adds a WebGPU implementation of geospatial volumetric clouds and
publishes it as
[`@yong_three/three-clouds`](https://www.npmjs.com/package/@yong_three/three-clouds).
The fork's WebGPU implementation includes cloud animation, custom layers,
temporal upscaling, beer shadow maps, shadows cast onto scene geometry, haze,
and light shafts.

The repository is based on
[`takram-design-engineering/three-geospatial`](https://github.com/takram-design-engineering/three-geospatial).
Takram remains the author of the original geospatial, atmosphere, effects, and
WebGL clouds implementation. This fork maintains the WebGPU clouds port and its
npm release; it is not an official Takram release.

See [`packages/clouds/README.md`](packages/clouds/README.md) for installation,
entry points, version compatibility, and working WebGPU examples.

## Packages

<!-- prettier-ignore -->
| Name | Description | Status | NPM |
| -- | -- | -- | -- |
| [atmosphere](packages/atmosphere) | An implementation of Precomputed Atmospheric Scattering | Beta | [@takram/three-atmosphere](https://www.npmjs.com/package/@takram/three-atmosphere) |
| [clouds](packages/clouds) | Geospatial volumetric clouds for WebGL and WebGPU | Beta | [@yong_three/three-clouds](https://www.npmjs.com/package/@yong_three/three-clouds) |
| [core](packages/core) | Provides fundamental functions for rendering GIS data | Alpha | [@takram/three-geospatial](https://www.npmjs.com/package/@takram/three-geospatial) |
| [effects](packages/effects) | A collection of post-processing effects | Alpha | [@takram/three-geospatial-effects](https://www.npmjs.com/package/@takram/three-geospatial-effects) |

Other packages not listed above are considered "examples" and are not intended for production use.

## WebGPU status in this fork

Clouds are implemented with the Three.js node API and exported from
`@yong_three/three-clouds/webgpu`. This is a separate API from the original
WebGL `CloudsEffect` and R3F `<Clouds>` component.

Available WebGPU stories:

- `clouds/Clouds > Basic`
- `clouds/Clouds > Custom Layers`
- `clouds/Clouds > Vanilla`

The production demo is available at
[`clouds.ceo-online.app`](https://clouds.ceo-online.app/?path=/story/clouds-clouds--basic).

![WebGPU volumetric clouds demo](packages/clouds/docs/webgpu-clouds-basic.png)

Run them locally on port 4004:

```sh
pnpm install
pnpm nx storybook storybook-webgpu --port=4004 --no-open
```

Then open
[`http://localhost:4004/?path=/story/clouds-clouds--basic`](http://localhost:4004/?path=/story/clouds-clouds--basic).

<!-- prettier-ignore -->
| Name | Status |
| -- | -- |
| [atmosphere](packages/atmosphere/WEBGPU.md) | Done |
| [clouds](packages/clouds/README.md#webgpu) | Implemented (Three.js node API) |
| [core](packages/core/WEBGPU.md) | Done |
| effects | To be merged with core |

## Developing

This repository uses a monorepo setup with [Nx](https://nx.dev). Please refer to its documentation for details.

The `packages` directory contains the publishable NPM packages listed above.

The `storybook` directory contains [Storybook](https://storybook.js.org) stories across the libraries. Stories are separated from the libraries to avoid circular dependencies. Story files and components are also separated to enable fast-refresh, which only works with files that contain components only.

The `apps` directory contains standalone applications.

- `data`: A command-line app for generating data.

### Installing

```sh
git clone https://github.com/ly05010419/three-geospatial.git
cd three-geospatial
pnpm install
```

This repository uses [Git LFS](https://git-lfs.com) for assets. You may need to [install it](https://docs.github.com/en/repositories/working-with-files/managing-large-files/installing-git-large-file-storage) and pull/fetch the assets using:

```sh
git lfs pull
```

### Commands

Project level commands are defined in [`project.json`](project.json). Library and app specific commands are defined in their respective `project.json` files, but most of them are inferred targets. You may need to run `pnpm nx show project {name}` to see them.

- `pnpm nx storybook storybook --port=4400 --no-open`: Run the WebGL Storybook locally.
- `pnpm nx storybook storybook-webgpu --port=4004 --no-open`: Run the WebGPU Storybook locally.
- `pnpm nx build`: Build all libraries and apps.
- `pnpm nx build-libs`: Build all libraries.
- `pnpm nx build {name}`: Build a specific library or app.
- `pnpm nx test`: Run unit tests.
- `pnpm nx lint`: Run linter.
- `pnpm nx format-all`: Run prettier.

### Environment variables

Create a `.env` file in the root directory with either of the following variables:

<!-- prettier-ignore -->
| Name | Description |
| -- | -- |
| `STORYBOOK_GOOGLE_MAP_API_KEY` | [Google Maps API key](https://developers.google.com/maps/documentation/tile/get-api-key) |
| `STORYBOOK_ION_API_TOKEN` | [Cesium Ion API access token](https://cesium.com/learn/ion/cesium-ion-access-tokens/) |

### Formatting and linting

Run `pnpm nx format-all` to format source code using Prettier. Ignore files you did not edit, as other files may also be formatted.

Run `pnpm nx lint` to check for non-formatting-related code conventions.

Alternatively, if you use VS Code, the [Prettier extension](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) and [ESLint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) can help.

### Running Storybook

This fork contains separate WebGL and WebGPU Storybooks. The Takram-hosted
Storybook shows the upstream implementation and does not contain this fork's
WebGPU clouds port.

Run the WebGPU clouds stories on port 4004:

```sh
pnpm nx storybook storybook-webgpu --port=4004 --no-open
```

Run the original WebGL stories on port 4400:

```sh
pnpm nx storybook storybook --port=4400 --no-open
```

### Note on Storybook errors

You may occasionally encounter the following errors, especially when switching branches:

```
The file does not exist at "..." which is in the optimize deps directory.
The dependency might be incompatible with the dep optimizer.
Try adding it to `optimizeDeps.exclude`.
```

or even `R3F: Hooks can only be used within the Canvas component!` error in the browser.

If the Storybook build succeeded on the commit you're currently on in Github Actions, the problem is likely not in the source or Storybook configuration. I haven't found a reliable way to prevent or recover from this.

In most cases, removing the Storybook cache, resetting Nx, restarting Storybook, and opening it in a _new browser window_ resolves the issue:

```sh
rm -r storybook/node_modules
pnpm nx reset
pnpm nx storybook storybook --port=4400 --no-open
```

If the problem persists, try clearing the browser cache.

### Generating a library

To generate a React library:

```sh
pnpm nx generate @nx/react:library --name={name} --bundler=vite --directory=packages/{name} --compiler=babel --importPath={package_name} --style=none --unitTestRunner=jest --no-interactive
```

To add a Storybook configuration:

```sh
pnpm nx generate @nx/storybook:configuration --project={name} --uiFramework=@storybook/react-vite --no-interactive
```

## License

[MIT](LICENSE)
