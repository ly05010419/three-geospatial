import type { Meta } from '@storybook/react-vite'

import { createStory } from '../components/createStory'
import { Story as BasicStory } from './Clouds-Basic'

import BasicCode from './Clouds-Basic?raw'

export default {
  title: 'clouds/Clouds',
  parameters: {
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
