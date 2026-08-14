import { Matrix4, Vector3 } from 'three'

import { AtmosphereContext } from './AtmosphereContext'

describe('AtmosphereContext', () => {
  test('round-trips positions through a translated local reference frame', () => {
    const context = new AtmosphereContext()
    context.matrixWorldToECEF.value
      .makeRotationY(Math.PI / 3)
      .setPosition(4_000_000, 3_000_000, 5_000_000)

    context.matrixECEFToWorld.update({} as any)

    const positionWorld = new Vector3(12, 34, 56)
    const roundTrip = positionWorld
      .clone()
      .applyMatrix4(context.matrixWorldToECEF.value)
      .applyMatrix4(context.matrixECEFToWorld.value)

    expect(roundTrip.distanceTo(positionWorld)).toBeLessThan(1e-8)
    expect(
      new Matrix4()
        .multiplyMatrices(
          context.matrixECEFToWorld.value,
          context.matrixWorldToECEF.value
        )
        .equals(new Matrix4())
    ).toBe(true)

    context.dispose()
  })
})
