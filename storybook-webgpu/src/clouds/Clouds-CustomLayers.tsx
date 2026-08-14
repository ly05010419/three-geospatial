import { CloudLayers } from '@yong_three/three-clouds'

import type { StoryFC } from '../components/createStory'
import { localDateArgs, localDateArgTypes } from '../controls/localDateControls'
import { locationArgs, locationArgTypes } from '../controls/locationControls'
import {
  Story as CloudsStory,
  type StoryArgs as CloudsStoryArgs
} from './Clouds-Basic'

// Ported one-for-one from the WebGL Custom Layers story. Each entry consumes
// one channel of the default local-weather texture.
const CUSTOM_LAYERS = new CloudLayers([
  {
    channel: 'r',
    altitude: 1000,
    height: 1000,
    shapeAmount: 0.8,
    weatherExponent: 0.6,
    shadow: true
  },
  {
    channel: 'g',
    altitude: 2000,
    height: 800,
    shapeAmount: 0.8,
    shapeAlteringBias: 0.5,
    densityScale: 0.1
  },
  {
    channel: 'b',
    altitude: 2000,
    height: 2000,
    densityScale: 2e-3,
    shapeAmount: 0.3
  },
  {
    channel: 'a',
    height: 300,
    densityScale: 0.05,
    shapeAmount: 0.2,
    shapeDetailAmount: 0,
    shapeAlteringBias: 0.5,
    coverageFilterWidth: 1,
    densityProfile: {
      expTerm: 1,
      exponent: 1e-3,
      constantTerm: 0,
      linearTerm: 0
    }
  }
])

const hiddenControl = {
  control: false,
  table: { disable: true }
} as const

export const Story: StoryFC<{}, CloudsStoryArgs> = props => (
  <CloudsStory
    {...props}
    cloudLayers={CUSTOM_LAYERS}
    enableDithering={false}
    localFrame
    temporalShadows={false}
  />
)

Story.args = {
  ...(CloudsStory.args ?? {}),
  animateClouds: false,
  animateDate: false,
  temporalUpscale: false,
  dateSpeed: 0.05,
  ...locationArgs({
    longitude: 30,
    latitude: 35,
    height: 500
  }),
  ...localDateArgs({
    dayOfYear: 1,
    timeOfDay: 13,
    year: 2025
  })
}

Story.argTypes = {
  ...CloudsStory.argTypes,
  coverage: hiddenControl,
  animateClouds: hiddenControl,
  cloudSpeed: hiddenControl,
  qualityPreset: hiddenControl,
  bsm: hiddenControl,
  temporalUpscale: hiddenControl,
  lightShafts: hiddenControl,
  surfaceShadows: hiddenControl,
  showShadowReceiver: hiddenControl,
  haze: hiddenControl,
  shapeDetail: hiddenControl,
  turbulence: hiddenControl,
  marchDebugShow: hiddenControl,
  resolveDebugShow: hiddenControl,
  animateDate: {
    control: { type: 'boolean' },
    table: { category: 'local date' }
  },
  dateSpeed: {
    name: 'speed',
    control: {
      type: 'range',
      min: -0.5,
      max: 0.5,
      step: 0.01
    },
    table: { category: 'local date' }
  },
  ...locationArgTypes(),
  ...localDateArgTypes()
}
