// Ported from the phase function section of clouds.frag:
// https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/src/shaders/clouds.frag

import { dot, float, max, mix, mul, PI, pow, vec2 } from 'three/tsl'

import { FnLayout, FnVar, type Node } from '@takram/three-geospatial/webgpu'

const RECIPROCAL_PI4 = 0.07957747154594767

export const henyeyGreenstein = /*#__PURE__*/ FnLayout({
  name: 'henyeyGreenstein',
  type: 'vec2',
  inputs: [
    { name: 'g', type: 'vec2' },
    { name: 'cosTheta', type: 'float' }
  ]
})(([g, cosTheta]) => {
  const g2 = g.mul(g).toConst()
  return mul(
    RECIPROCAL_PI4,
    g2
      .oneMinus()
      .div(
        max(vec2(1e-7), pow(g2.add(1).sub(g.mul(2).mul(cosTheta)), vec2(1.5)))
      )
  )
})

export const draine = /*#__PURE__*/ FnLayout({
  name: 'draine',
  type: 'float',
  inputs: [
    { name: 'u', type: 'float' },
    { name: 'g', type: 'float' },
    { name: 'a', type: 'float' }
  ]
})(([u, g, a]) => {
  const g2 = g.mul(g).toConst()
  return g2
    .oneMinus()
    .mul(a.mul(u).mul(u).add(1))
    .div(
      mul(
        4,
        a.mul(g2.mul(2).add(1)).div(3).add(1),
        PI,
        pow(g2.add(1).sub(g.mul(2).mul(u)), 1.5)
      )
    )
})

export interface PhaseFunctionOptions {
  // Corresponds to the ACCURATE_PHASE_FUNCTION define. Selects the
  // numerically-fitted HG + Draine phase function instead of the dual-lobe
  // Henyey-Greenstein at build time.
  accuratePhaseFunction?: boolean
  // Correspond to the SCATTER_ANISOTROPY_1, SCATTER_ANISOTROPY_2 and
  // SCATTER_ANISOTROPY_MIX defines. Ideally these should be uniforms, but
  // because the phase function is highly optimizable and used many times,
  // baking them as constants improves fps by around 2-4, depending on the
  // condition.
  scatterAnisotropy1?: number
  scatterAnisotropy2?: number
  scatterAnisotropyMix?: number
}

export const phaseFunction = /*#__PURE__*/ FnVar(
  (
    cosTheta: Node<'float'>,
    attenuation: Node<'float'> | number = 1,
    {
      accuratePhaseFunction = false,
      scatterAnisotropy1 = 0.7,
      scatterAnisotropy2 = -0.2,
      scatterAnisotropyMix = 0.5
    }: PhaseFunctionOptions = {}
  ): Node<'float'> => {
    const attenuationNode =
      typeof attenuation === 'number' ? float(attenuation) : attenuation

    if (accuratePhaseFunction) {
      // Numerically-fitted large particles (d=10) phase function. It won't be
      // plausible without a more precise multiple scattering.
      // Reference: https://research.nvidia.com/labs/rtr/approximate-mie/
      const gHG = 0.988176691700256 // exp(-0.0990567/(d-1.67154))
      const gD = 0.5556712547839497 // exp(-2.20679/(d+3.91029)-0.428934)
      const alpha = 21.995520856274638 // exp(3.62489-8.29288/(d+5.52825))
      const weight = 0.4819554318404214 // exp(-0.599085/(d-0.641583)-0.665888)
      return mix(
        henyeyGreenstein(vec2(gHG).mul(attenuationNode), cosTheta).x,
        draine(cosTheta, mul(gD, attenuationNode), alpha),
        weight
      )
    }

    const g = vec2(scatterAnisotropy1, scatterAnisotropy2).toConst()
    const weights = vec2(
      1 - scatterAnisotropyMix,
      scatterAnisotropyMix
    ).toConst()
    // A similar approximation is described in the Frostbite's paper, where
    // phase angle is attenuated instead of anisotropy.
    return dot(henyeyGreenstein(g.mul(attenuationNode), cosTheta), weights)
  }
)
