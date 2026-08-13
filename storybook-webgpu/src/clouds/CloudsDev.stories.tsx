import type { Meta } from '@storybook/react-vite'

import { createStory } from '../components/createStory'
import { Story as ProbesStory } from './CloudsDev-Probes'
import { Story as ShadowMapStory } from './CloudsDev-ShadowMap'
import { Story as ShadowSamplingStory } from './CloudsDev-ShadowSampling'
import { Story as WeatherStory } from './CloudsDev-Weather'

import ProbesCode from './CloudsDev-Probes?raw'
import ShadowMapCode from './CloudsDev-ShadowMap?raw'
import ShadowSamplingCode from './CloudsDev-ShadowSampling?raw'
import WeatherCode from './CloudsDev-Weather?raw'

export default {
  title: 'clouds/Developer',
  parameters: {
    docs: {
      codePanel: true,
      source: {
        language: 'tsx'
      }
    }
  }
} satisfies Meta

export const Probes = createStory(ProbesStory, {
  parameters: {
    docs: {
      source: {
        code: ProbesCode
      }
    }
  }
})

export const Weather = createStory(WeatherStory, {
  parameters: {
    docs: {
      source: {
        code: WeatherCode
      }
    }
  }
})

export const ShadowSampling = createStory(ShadowSamplingStory, {
  parameters: {
    docs: {
      source: {
        code: ShadowSamplingCode
      }
    }
  }
})

export const ShadowMap = createStory(ShadowMapStory, {
  parameters: {
    docs: {
      source: {
        code: ShadowMapCode
      }
    }
  }
})
