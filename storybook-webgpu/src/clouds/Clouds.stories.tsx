import type { Meta } from '@storybook/react-vite'

import { createStory } from '../components/createStory'
import { Story as BasicStory } from './Clouds-Basic'
import { Story as CustomLayersStory } from './Clouds-CustomLayers'
import { Story as VanillaStory } from './Clouds-Vanilla'

import BasicCode from './Clouds-Basic?raw'
import CustomLayersCode from './Clouds-CustomLayers?raw'
import VanillaCode from './Clouds-Vanilla?raw'

export default {
  title: 'clouds/Clouds',
  parameters: {
    layout: 'fullscreen',
    docs: {
      codePanel: true,
      source: {
        language: 'tsx'
      }
    }
  }
} satisfies Meta

export const Basic = createStory(BasicStory, {
  parameters: {
    docs: {
      source: {
        code: BasicCode
      }
    }
  }
})

export const CustomLayers = createStory(CustomLayersStory, {
  parameters: {
    docs: {
      source: {
        code: CustomLayersCode
      }
    }
  }
})

export const Vanilla = createStory(VanillaStory, {
  parameters: {
    docs: {
      source: {
        code: VanillaCode
      }
    }
  }
})
