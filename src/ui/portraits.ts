import {
  Color3, Color4, DirectionalLight, FreeCamera, HemisphericLight, MeshBuilder, MultiMaterial, Scene, StandardMaterial, Tools,
  TransformNode, Vector3, type AbstractMesh, type Engine,
} from "@babylonjs/core";
import { PLAYER, type UnitType } from "../config";
import {
  createChargeMesh, createJeepBody, createJeepGun, createJeepWheel, createSoldierTemplates, HIP_X, HIP_Y, JEEP_DIM, SHOULDER_Y,
  type SoldierTemplates,
} from "../world/models";
import { buildLeg, buildUpper } from "../game/views";

const SIZE = 256;

/** Assembles a standing soldier from the instancing templates. */
function soldier(scene: Scene, tpl: SoldierTemplates, legs = true): TransformNode {
  const root = new TransformNode("portraitSoldier", scene);
  tpl.body.createInstance("b").parent = root;
  buildUpper(tpl, root);
  if (legs) {
    buildLeg(tpl, root, -HIP_X).thigh.rotation.x = 0.12;
    const r = buildLeg(tpl, root, HIP_X);
    r.thigh.rotation.x = -0.15;
    r.shin.rotation.x = 0.2;
  }
  return root;
}

/**
 * Renders "cameo" portraits of the player's units for the build menu from the real 3D models:
 * soldiers as a heroic 3/4 bust shot from slightly below, the jeep in a low front 3/4 view.
 * Warm key light, cool rim light, transparent background (the button supplies the backdrop).
 */
export type PortraitImages = Record<UnitType, string> & { cloak: string; charge: string };

/** Gives every material of `meshes` a translucent, cold glow: the cloaked agent's ghostly look. */
function ghost(meshes: AbstractMesh[]) {
  const done = new Map<StandardMaterial, StandardMaterial>();
  const g = (m: StandardMaterial) => {
    let c = done.get(m);
    if (!c) {
      c = m.clone(`${m.name}-ghost`);
      c.alpha = 0.32;
      c.emissiveColor = new Color3(0.25, 0.6, 0.75);
      done.set(m, c);
    }
    return c;
  };
  for (const mesh of meshes) {
    const src = mesh.material;
    if (src instanceof MultiMaterial) {
      const mm = src.clone(`${src.name}-ghost`) as MultiMaterial;
      mm.subMaterials = src.subMaterials.map((s) => (s instanceof StandardMaterial ? g(s) : s));
      mesh.material = mm;
    } else if (src instanceof StandardMaterial) {
      mesh.material = g(src);
    }
  }
}

export async function renderPortraits(engine: Engine): Promise<PortraitImages> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 0);
  scene.detachControl();
  scene.imageProcessingConfiguration.contrast = 1.3;
  scene.imageProcessingConfiguration.exposure = 1.1;

  const hemi = new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.45;
  hemi.diffuse = new Color3(0.6, 0.7, 0.95);
  hemi.groundColor = new Color3(0.25, 0.2, 0.15);
  hemi.specular = Color3.Black();
  const key = new DirectionalLight("key", new Vector3(0.6, -0.5, -0.7), scene);
  key.intensity = 1.5;
  key.diffuse = new Color3(1, 0.85, 0.65);
  key.specular = Color3.Black();
  const rim = new DirectionalLight("rim", new Vector3(-0.8, -0.2, 0.7), scene);
  rim.intensity = 1.1;
  rim.diffuse = new Color3(0.55, 0.75, 1);
  rim.specular = Color3.Black();

  const cam = new FreeCamera("portraitCam", Vector3.Zero(), scene);
  cam.minZ = 0.1;
  const shoot = async (pos: Vector3, target: Vector3, fov: number) => {
    cam.position.copyFrom(pos);
    cam.setTarget(target);
    cam.fov = fov;
    // lights follow the camera: warm key from front-left above, cool rim from behind-right
    const view = target.subtract(pos).normalize();
    const right = Vector3.Cross(Vector3.Up(), view).normalize();
    key.direction = view.add(right.scale(0.55)).add(new Vector3(0, -0.75, 0)).normalize();
    rim.direction = view.scale(-1).add(right.scale(-0.7)).add(new Vector3(0, -0.35, 0)).normalize();
    await scene.whenReadyAsync();
    return Tools.CreateScreenshotUsingRenderTargetAsync(engine, cam, { width: SIZE, height: SIZE }, "image/png", 4);
  };

  const result = {} as PortraitImages;

  // rifleman: slightly from below and to the side, rifle at the ready
  const rifle = createSoldierTemplates(scene, PLAYER);
  let node = soldier(scene, rifle);
  node.rotation.y = -0.35;
  result.rifleman = await shoot(new Vector3(0.8, 2.2, 2.4), new Vector3(0.05, 2.02, 0), 0.72);
  node.dispose();

  // grenadier: grenade raised over the shoulder
  const gren = createSoldierTemplates(scene, PLAYER, true);
  node = soldier(scene, gren);
  node.rotation.y = 0.3;
  result.grenadier = await shoot(new Vector3(-0.75, 2.25, 2.5), new Vector3(0.12, 2.18, 0), 0.8);
  node.dispose();

  // medic: turned so the red cross on helmet, armband and satchel shows
  const medic = createSoldierTemplates(scene, PLAYER, "medic");
  node = soldier(scene, medic);
  node.rotation.y = 0.5;
  result.medic = await shoot(new Vector3(-0.7, 2.3, 2.4), new Vector3(0.05, 2.0, 0), 0.76);
  node.dispose();

  // jeep: low front three-quarter view with driver and gunner behind the MG
  const D = JEEP_DIM;
  const jeep = new TransformNode("portraitJeep", scene);
  createJeepBody(scene, PLAYER).createInstance("hull").parent = jeep;
  const wheel = createJeepWheel(scene);
  for (const [x, z] of [[-D.wheelX, D.wheelZ], [D.wheelX, D.wheelZ], [-D.wheelX, -D.wheelZ], [D.wheelX, -D.wheelZ]]) {
    const w = wheel.createInstance("wheel");
    w.parent = jeep;
    w.position.set(x, D.wheelR, z);
    if (z > 0) w.rotation.y = -0.25;
  }
  const turret = new TransformNode("turret", scene);
  turret.parent = jeep;
  turret.position.set(0, D.turret.y, D.turret.z);
  turret.rotation.y = 0.35;
  createJeepGun(scene).createInstance("gun").parent = turret;
  const gunner = soldier(scene, rifle);
  gunner.parent = turret;
  gunner.position.set(0, D.bedY - D.turret.y, -0.75);
  const driver = soldier(scene, rifle, false);
  driver.parent = jeep;
  driver.position.set(D.driver.x, D.bedY + 0.42 - HIP_Y, D.driver.z);
  jeep.rotation.y = Math.PI + 0.6;
  result.jeep = await shoot(new Vector3(-2.2, 2.4, -7.4), new Vector3(0.1, 1.35, 0), 0.6);

  // demolition charge: close-up of the bundle strapped to the jeep's bonnet, lamp glowing
  jeep.rotation.y = 0;
  turret.rotation.y = 0;
  const charge = createChargeMesh(scene);
  charge.parent = jeep;
  charge.position.set(0.45, 1.44, 1.45);
  charge.rotation.y = 0.5;
  charge.scaling.setAll(1.7);
  const glow = MeshBuilder.CreateSphere("glow", { diameter: 0.3, segments: 8 }, scene);
  const glowMat = new StandardMaterial("glowMat", scene);
  glowMat.emissiveColor = new Color3(1, 0.3, 0.15);
  glowMat.disableLighting = true;
  glowMat.alpha = 0.3;
  glow.material = glowMat;
  glow.parent = charge;
  glow.position.set(0.05, 0.29, 0.03);
  charge.computeWorldMatrix(true);
  const cw = charge.getAbsolutePosition().add(new Vector3(0, 0.25, 0));
  result.charge = await shoot(cw.add(new Vector3(-1.0, 0.95, 1.55)), cw, 0.75);
  jeep.dispose(false, true);

  // cloak: the agent fading into a translucent, cold shimmer
  const agent = createSoldierTemplates(scene, PLAYER, "agent");
  ghost([agent.body, agent.arms, agent.head, agent.leg, agent.shin]);
  node = soldier(scene, agent);
  node.rotation.y = -0.45;
  result.cloak = await shoot(new Vector3(0.9, 2.1, 2.9), new Vector3(0.05, 1.75, 0), 0.8);
  node.dispose();

  scene.dispose();
  return result;
}
