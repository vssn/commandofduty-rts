import { Color3, Color4, DirectionalLight, HemisphericLight, Scene, ShadowGenerator, Vector3 } from "@babylonjs/core";

const HAZE = new Color3(0.76, 0.79, 0.82);
const SUN_DIR = new Vector3(0.74, -0.5, 0.36).normalize();

/** Autumn afternoon lighting: warm low sun from the south-west, cool sky fill, light haze. */
export function createEnvironment(scene: Scene) {
  scene.clearColor = new Color4(HAZE.r, HAZE.g, HAZE.b, 1);
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogColor = HAZE;
  scene.fogStart = 150;
  scene.fogEnd = 340;

  const hemi = new HemisphericLight("sky", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.62;
  hemi.diffuse = new Color3(0.78, 0.84, 0.98);
  hemi.groundColor = new Color3(0.42, 0.36, 0.28);
  hemi.specular = Color3.Black();

  const sun = new DirectionalLight("sun", SUN_DIR.clone(), scene);
  sun.intensity = 1.2;
  sun.diffuse = new Color3(1.0, 0.86, 0.68);
  sun.specular = Color3.Black();
  sun.shadowFrustumSize = 200;
  sun.autoCalcShadowZBounds = false;
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 420;

  const shadows = new ShadowGenerator(4096, sun);
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadows.bias = 0.0015;
  shadows.normalBias = 0.02;
  shadows.setDarkness(0.3);

  const ip = scene.imageProcessingConfiguration;
  ip.contrast = 1.18;
  ip.exposure = 1.04;
  ip.vignetteEnabled = true;
  ip.vignetteWeight = 1.1;
  ip.vignetteColor = new Color4(0.1, 0.07, 0.04, 0);

  /** Keeps the fixed-size shadow frustum centred on what the camera is looking at. */
  const followFocus = (focus: Vector3) => {
    sun.position.copyFrom(focus).subtractInPlace(SUN_DIR.scale(200));
  };

  return { sun, shadows, followFocus };
}
