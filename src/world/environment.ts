import { Color3, Color4, DirectionalLight, HemisphericLight, Scene, ShadowGenerator, Vector3 } from "@babylonjs/core";

/** Backdrop behind and below the terrain (beyond the cliffs): dark, so no bright gaps show. */
const HAZE = new Color3(0.16, 0.18, 0.21);
const SUN_DIR = new Vector3(0.74, -0.5, 0.36).normalize();

/** Autumn afternoon lighting: warm low sun from the south-west, cool sky fill, light haze. */
export function createEnvironment(scene: Scene) {
  scene.clearColor = new Color4(HAZE.r, HAZE.g, HAZE.b, 1);
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogColor = HAZE;
  scene.fogStart = 175;
  scene.fogEnd = 380;

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

  const day = {
    clear: scene.clearColor.clone(), fog: scene.fogColor.clone(),
    hemi: [hemi.intensity, hemi.diffuse.clone(), hemi.groundColor.clone()] as const,
    sun: [sun.intensity, sun.diffuse.clone()] as const,
    darkness: shadows.getDarkness(), exposure: ip.exposure, contrast: ip.contrast, vignette: [ip.vignetteWeight, ip.vignetteColor.clone()] as const,
  };

  /** Moonlit night (commandos): dim blue moon light, dark sky, stronger vignette. `false` restores the day. */
  const setNight = (on = true) => {
    if (!on) {
      scene.clearColor = day.clear.clone();
      scene.fogColor = day.fog.clone();
      [hemi.intensity] = day.hemi;
      hemi.diffuse = day.hemi[1].clone();
      hemi.groundColor = day.hemi[2].clone();
      sun.intensity = day.sun[0];
      sun.diffuse = day.sun[1].clone();
      shadows.setDarkness(day.darkness);
      ip.exposure = day.exposure;
      ip.contrast = day.contrast;
      ip.vignetteWeight = day.vignette[0];
      ip.vignetteColor = day.vignette[1].clone();
      return;
    }
    const night = new Color3(0.035, 0.045, 0.08);
    scene.clearColor = new Color4(night.r, night.g, night.b, 1);
    scene.fogColor = night;
    hemi.intensity = 0.28;
    hemi.diffuse = new Color3(0.45, 0.55, 0.85);
    hemi.groundColor = new Color3(0.08, 0.08, 0.12);
    sun.intensity = 0.42;
    sun.diffuse = new Color3(0.6, 0.7, 1.0);
    shadows.setDarkness(0.45);
    ip.exposure = 0.92;
    ip.contrast = 1.25;
    ip.vignetteWeight = 2.2;
    ip.vignetteColor = new Color4(0.01, 0.02, 0.05, 0);
  };

  return { sun, shadows, followFocus, setNight };
}
