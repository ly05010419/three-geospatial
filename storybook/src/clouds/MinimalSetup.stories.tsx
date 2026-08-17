import { Canvas } from '@react-three/fiber'
import { EffectComposer, ToneMapping } from '@react-three/postprocessing'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ToneMappingMode } from 'postprocessing'
import { Fragment, useEffect, useState, type FC } from 'react'
import type { Material } from 'three'

import { AerialPerspective, Atmosphere } from '@takram/three-atmosphere/r3f'
import type { CloudsEffect } from '@yong_three/three-clouds'
import { Clouds } from '@yong_three/three-clouds/r3f'
import { LensFlare } from '@takram/three-geospatial-effects/r3f'

const DEBUG_SHOW_OPTIONS = [
  'none',
  'shadowLength',
  'velocity',
  'frontDepth',
  'shadowMap',
  'uv',
  'sampleCount'
] as const

type DebugShow = (typeof DEBUG_SHOW_OPTIONS)[number]

interface MinimalSetupArgs {
  /** Whether to render the Clouds effect at all (A/B baseline toggle). */
  clouds: boolean
  /** Forwarded to CloudsEffect.coverage; 0.3 is the effect's default. */
  coverage: number
  /**
   * Forwarded to CloudsEffect.turbulence, which toggles the TURBULENCE define
   * on both the clouds and shadow materials; true is the effect's default.
   */
  turbulence: boolean
  /**
   * Forwarded to CloudsEffect.shapeDetail, which toggles the SHAPE_DETAIL
   * define on both the clouds and shadow materials; true is the effect's
   * default.
   */
  shapeDetail: boolean
  /**
   * Whether to render LensFlare + ToneMapping. When false the output is linear,
   * mirroring Clouds-Basic's debug mode (toneMapping=false).
   */
  postEffects: boolean
  /**
   * Debug visualization; toggles the DEBUG_SHOW_* defines on the CloudsEffect
   * materials exactly like useCloudsControls' "debug" folder does.
   */
  debugShow: DebugShow
}

type DefinesMaterial = Material & { defines: Record<string, unknown> }

// Same helper as storybook/src/clouds/helpers/useCloudsControls.ts.
function setBooleanDefine(
  material: DefinesMaterial,
  key: string,
  value: boolean
): void {
  if (value) {
    material.defines[key] = '1'
  } else {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete material.defines[key]
  }
}

// Which define lives on which material (see useDebugCloudControls).
const RESOLVE_MATERIAL_DEFINES: Partial<Record<DebugShow, string>> = {
  shadowLength: 'DEBUG_SHOW_SHADOW_LENGTH',
  velocity: 'DEBUG_SHOW_VELOCITY'
}
const CURRENT_MATERIAL_DEFINES: Partial<Record<DebugShow, string>> = {
  frontDepth: 'DEBUG_SHOW_FRONT_DEPTH',
  shadowMap: 'DEBUG_SHOW_SHADOW_MAP',
  uv: 'DEBUG_SHOW_UV',
  sampleCount: 'DEBUG_SHOW_SAMPLE_COUNT'
}

function applyDebugDefines(
  material: DefinesMaterial,
  defines: Partial<Record<DebugShow, string>>,
  debugShow: DebugShow
): void {
  for (const [option, define] of Object.entries(defines)) {
    setBooleanDefine(material, define, option === debugShow)
  }
  material.needsUpdate = true
}

function useDebugShow(effect: CloudsEffect | null, debugShow: DebugShow): void {
  useEffect(() => {
    if (effect == null) {
      return
    }
    applyDebugDefines(
      effect.cloudsPass.resolveMaterial,
      RESOLVE_MATERIAL_DEFINES,
      debugShow
    )
    applyDebugDefines(
      effect.cloudsPass.currentMaterial,
      CURRENT_MATERIAL_DEFINES,
      debugShow
    )
  }, [effect, debugShow])
}

const MinimalSetupScene: FC<MinimalSetupArgs> = ({
  clouds,
  coverage,
  turbulence,
  shapeDetail,
  postEffects,
  debugShow
}) => {
  const [effect, setEffect] = useState<CloudsEffect | null>(null)
  useDebugShow(effect, debugShow)

  return (
    <Canvas
      gl={{
        depth: false,
        toneMappingExposure: 10
      }}
      camera={{
        near: 1,
        far: 4e5,
        // See the Clouds/Basic story for deriving ECEF coordinates and rotation.
        position: [4529893.894855564, 2615333.425024031, 3638042.815326614],
        rotation: [0.6423512931563148, -0.2928348796035058, -0.8344824769956042]
      }}
    >
      <Atmosphere date={Date.parse('2025-01-01T07:00:00Z')}>
        <EffectComposer multisampling={0} enableNormalPass>
          <Fragment
            // Effects are order-dependant; we need to reconstruct the nodes.
            key={JSON.stringify([clouds, postEffects])}
          >
            {clouds && (
              <Clouds
                ref={setEffect}
                coverage={coverage}
                turbulence={turbulence}
                shapeDetail={shapeDetail}
                // useCloudsControls also disables temporal upscaling when
                // showing the shadow map; true is the effect's default.
                temporalUpscale={debugShow !== 'shadowMap'}
              />
            )}
            <AerialPerspective sky sunLight skyLight />
            {postEffects && (
              <>
                <LensFlare />
                <ToneMapping mode={ToneMappingMode.AGX} />
              </>
            )}
          </Fragment>
        </EffectComposer>
      </Atmosphere>
    </Canvas>
  )
}

export default {
  title: 'clouds/Minimal Setup',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta<MinimalSetupArgs>

export const MinimalSetup: StoryObj<MinimalSetupArgs> = {
  args: {
    clouds: true,
    coverage: 0.3,
    turbulence: true,
    shapeDetail: true,
    postEffects: true,
    debugShow: 'none'
  },
  argTypes: {
    clouds: { control: 'boolean' },
    coverage: { control: { type: 'range', min: 0, max: 1, step: 0.01 } },
    turbulence: { control: 'boolean' },
    shapeDetail: { control: 'boolean' },
    postEffects: { control: 'boolean' },
    debugShow: { control: 'select', options: DEBUG_SHOW_OPTIONS }
  },
  render: args => <MinimalSetupScene {...args} />
}
