// Lineside objects driven by the network: signals, route indicators, speed boards, point levers, buffer stops and stations.
import * as THREE from 'three';

import type { Network, RailNode, Side, SignalType, SpeedSign, Station } from '../rail/network';
import { computeSpeedSigns, signalType } from '../rail/network';
import type { Sim } from '../rail/sim';
import { keyOf } from '../rail/sim';
import type { Assets } from './assets';

const LAMP_INTENSITY = { red: 26, yellow: 22, green: 16, white: 18 };

interface SignalVisual {
  key: string;
  type: SignalType;
  lamps: {
    red?: THREE.MeshStandardMaterial;
    yellow?: THREE.MeshStandardMaterial;
    green?: THREE.MeshStandardMaterial;
    white?: THREE.MeshStandardMaterial;
  };
  route?: {
    left: THREE.MeshStandardMaterial;
    right: THREE.MeshStandardMaterial;
    numMat: THREE.MeshStandardMaterial;
    lastKey: string;
  };
  glow: THREE.Sprite;
  pos: THREE.Vector3;
  last?: string;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function signTexture(text: string) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = '#16365a';
  g.fillRect(0, 0, 512, 96);
  g.strokeStyle = '#eef0ea';
  g.lineWidth = 5;
  g.strokeRect(6, 6, 500, 84);
  g.fillStyle = '#f4f5f0';
  g.font = '600 56px Overpass, Helvetica, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 52);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function speedSignTexture(kmh: number, advance: boolean) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  if (advance) {
    g.fillStyle = '#15282a';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#f0a62b';
    g.fillRect(10, 10, 236, 236);
    g.fillStyle = '#f3efe0';
    g.fillRect(26, 26, 204, 204);
    g.fillStyle = '#15282a';
    g.font = '700 108px "Barlow Condensed", "Arial Narrow", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(kmh), 128, 106);
    // Downward chevron warns that a lower limit lies ahead.
    g.beginPath();
    g.moveTo(86, 174);
    g.lineTo(170, 174);
    g.lineTo(128, 214);
    g.closePath();
    g.fill();
  } else {
    g.fillStyle = '#15282a';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#f3efe0';
    g.beginPath();
    g.arc(128, 128, 114, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#c9302a';
    g.lineWidth = 22;
    g.beginPath();
    g.arc(128, 128, 103, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#15282a';
    g.font = `700 ${kmh >= 100 ? 96 : 114}px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(kmh), 128, 134);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function routeNumTexture(num: number) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0e1315';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#f4f1de';
  g.font = '700 92px "Barlow Condensed", "Arial Narrow", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(num), 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function hasFacingJunctionInBlock(net: Network, startNode: number, startSide: Side): boolean {
  if (net.attached(startNode, startSide).length > 1) return true;
  const seen = new Set<number>();
  const walk = (segId: number, dir: 1 | -1, depth: number): boolean => {
    if (seen.has(segId) || depth > 16) return false;
    seen.add(segId);
    const e = net.exit(segId, dir);
    const def = net.nodes.get(e.node)!.signals[e.side];
    if (def && signalType(def) !== 'distant') return false;
    if (e.options.length > 1) return true;
    for (const opt of e.options) {
      if (walk(opt, net.entryDir(opt, e.node, e.side), depth + 1)) return true;
    }
    return false;
  };
  for (const opt of net.attached(startNode, startSide)) {
    if (walk(opt, net.entryDir(opt, startNode, startSide), 0)) return true;
  }
  return false;
}

export class PropsRenderer {
  group = new THREE.Group();
  private signals = new Map<string, SignalVisual>();
  private lastVersion = -1;
  private lamps: THREE.Vector3[] = [];
  private lightPool: THREE.PointLight[] = [];
  private glowTex = glowTexture();
  private levers = new Map<string, { arm: THREE.Object3D; node: number; side: Side }>();
  private speedTex = new Map<string, THREE.CanvasTexture>();
  private routeTex = new Map<number, THREE.CanvasTexture>();
  private speedMats: THREE.MeshStandardMaterial[] = [];
  /** Lamps nearest the camera first. Re-sorted in place only once the camera has moved a fair way. */
  private nearLamps: THREE.Vector3[] = [];
  private sortedAt = new THREE.Vector3(Infinity, 0, 0);
  // Shared by every rebuild, so never disposed when props are cleared.
  private armGeo = new THREE.BoxGeometry(0.46, 0.46, 0.04);
  private boardGeo = new THREE.PlaneGeometry(6.4, 1.2);
  private postGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.5, 6);
  private postMat = new THREE.MeshStandardMaterial({ color: 0x25292c, roughness: 0.6 });
  private darkSteelMat = new THREE.MeshStandardMaterial({ color: 0x1b1e20, roughness: 0.55, metalness: 0.4 });
  private brassMat = new THREE.MeshStandardMaterial({ color: 0xc7a350, roughness: 0.35, metalness: 0.7 });
  private amberPaintMat = new THREE.MeshStandardMaterial({ color: 0xf0a62b, roughness: 0.45 });
  private creamPaintMat = new THREE.MeshStandardMaterial({ color: 0xe9e4d2, roughness: 0.5 });
  private concreteMat = new THREE.MeshStandardMaterial({ color: 0x7b7b75, roughness: 0.9 });
  private speedPostGeo = new THREE.CylinderGeometry(0.045, 0.045, 2.35, 6);
  private speedBoardGeo = new THREE.PlaneGeometry(1.15, 1.15);
  private speedBackGeo = new THREE.BoxGeometry(1.18, 1.18, 0.04);
  private routeBoxGeo = new THREE.BoxGeometry(0.96, 0.58, 0.14);
  private routeTrimGeo = new THREE.BoxGeometry(1.02, 0.64, 0.1);
  private routeNumGeo = new THREE.PlaneGeometry(0.32, 0.38);
  private featherDotGeo = (() => {
    const g = new THREE.CylinderGeometry(0.038, 0.038, 0.04, 8);
    g.rotateX(Math.PI / 2);
    return g;
  })();
  private distantBaseGeo = new THREE.CylinderGeometry(0.2, 0.28, 0.35, 10);
  private distantPostGeo = new THREE.CylinderGeometry(0.065, 0.075, 4.6, 10);
  private distantBandGeo = new THREE.CylinderGeometry(0.074, 0.074, 0.42, 10);
  private distantDiamondGeo = new THREE.BoxGeometry(0.56, 0.56, 0.05);
  private distantDiamondInnerGeo = new THREE.BoxGeometry(0.42, 0.42, 0.06);
  private distantHeadGeo = new THREE.BoxGeometry(0.46, 0.94, 0.16);
  private distantLensGeo = (() => {
    const g = new THREE.CylinderGeometry(0.125, 0.125, 0.04, 16);
    g.rotateX(Math.PI / 2);
    return g;
  })();
  private hoodGeo = new THREE.BoxGeometry(0.3, 0.03, 0.26);
  private shuntBaseGeo = new THREE.BoxGeometry(0.44, 0.2, 0.44);
  private shuntPostGeo = new THREE.CylinderGeometry(0.055, 0.065, 1.0, 8);
  private shuntHeadGeo = new THREE.BoxGeometry(0.62, 0.62, 0.2);
  private shuntStripeGeo = new THREE.BoxGeometry(0.64, 0.08, 0.22);
  private shuntLensGeo = (() => {
    const g = new THREE.CylinderGeometry(0.09, 0.09, 0.04, 14);
    g.rotateX(Math.PI / 2);
    return g;
  })();
  /** Per-instance materials and textures made by the current build, freed on the next. */
  private owned: { dispose(): void }[] = [];

  constructor(
    scene: THREE.Scene,
    private assets: Assets,
  ) {
    scene.add(this.group);
    for (let i = 0; i < 5; i++) {
      const l = new THREE.PointLight(0xffc27a, 0, 34, 1.8);
      l.castShadow = false;
      this.lightPool.push(l);
      scene.add(l);
    }
  }

  /** Rebuilds when the network was edited. */
  sync(net: Network) {
    if (net.version === this.lastVersion) return;
    this.lastVersion = net.version;
    this.rebuild(net);
  }

  invalidate() {
    this.lastVersion = -1;
  }

  private clearGroup() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.traverse((o) => {
        const s = o as THREE.Sprite;
        if (s.isSprite) s.material.dispose();
        const im = o as THREE.InstancedMesh;
        if (im.isInstancedMesh) im.dispose();
      });
    }
    for (const r of this.owned) r.dispose();
    this.owned = [];
    this.speedMats = [];
    this.signals.clear();
    this.levers.clear();
    this.lamps = [];
    this.nearLamps = [];
  }

  private rebuild(net: Network) {
    this.clearGroup();
    for (const node of net.nodes.values()) {
      for (const side of [1, -1] as Side[]) {
        if (node.signals[side]) this.addSignal(net, node, side);
        const opts = net.attached(node.id, side);
        if (opts.length > 1) this.addLever(node, side);
        if (opts.length === 0 && net.attached(node.id, -side as Side).length > 0) this.addBuffer(node, side);
      }
    }
    for (const sign of computeSpeedSigns(net)) this.addSpeedSign(sign);
    for (const st of net.stations) this.addStation(net, st);
  }

  private addSpeedSign(sign: SpeedSign) {
    const pos = new THREE.Vector3(sign.x + -sign.tz * 2.55, sign.y - 0.2, sign.z + sign.tx * 2.55);
    const holder = new THREE.Group();
    holder.position.copy(pos);
    holder.rotation.y = Math.atan2(-sign.tx, -sign.tz);

    const post = new THREE.Mesh(this.speedPostGeo, this.postMat);
    post.position.set(0, 1.15, -0.04);
    post.castShadow = true;
    holder.add(post);

    const back = new THREE.Mesh(this.speedBackGeo, this.darkSteelMat);
    back.position.set(0, 2.25, -0.02);
    back.castShadow = true;
    holder.add(back);

    const texKey = `${sign.advance ? 'adv' : 'main'}:${sign.kmh}`;
    let tex = this.speedTex.get(texKey);
    if (!tex) {
      tex = speedSignTexture(sign.kmh, sign.advance);
      this.speedTex.set(texKey, tex);
    }
    const faceMat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.4,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: 0.14,
    });
    this.owned.push(faceMat);
    this.speedMats.push(faceMat);
    const face = new THREE.Mesh(this.speedBoardGeo, faceMat);
    face.position.set(0, 2.25, 0.005);
    holder.add(face);

    this.group.add(holder);
  }

  private setupLamp(mat: THREE.MeshStandardMaterial, color: number, emissive: number) {
    mat.color.set(color);
    mat.emissive.set(emissive);
    mat.roughness = 0.25;
    mat.emissiveIntensity = 0;
    this.owned.push(mat);
    return mat;
  }

  private addSignal(net: Network, node: RailNode, side: Side) {
    const type = signalType(node.signals[side]);
    const tx = node.dx * side;
    const tz = node.dz * side;
    const yaw = Math.atan2(-tx, -tz);
    const key = keyOf(node.id, side);

    if (type === 'shunt') {
      const pos = new THREE.Vector3(node.x + -tz * 2.45 - tx * 2.5, node.y - 0.35, node.z + tx * 2.45 - tz * 2.5);
      const obj = new THREE.Group();
      obj.position.copy(pos);
      obj.rotation.y = yaw;
      const base = new THREE.Mesh(this.shuntBaseGeo, this.concreteMat);
      base.position.y = 0.1;
      const post = new THREE.Mesh(this.shuntPostGeo, this.darkSteelMat);
      post.position.y = 0.7;
      const head = new THREE.Mesh(this.shuntHeadGeo, this.darkSteelMat);
      head.position.set(0, 1.38, 0);
      const stripe = new THREE.Mesh(this.shuntStripeGeo, this.creamPaintMat);
      stripe.position.set(0, 1.03, 0);
      obj.add(base, post, head, stripe);

      const red = this.setupLamp(new THREE.MeshStandardMaterial(), 0x2a0606, 0xff1a10);
      const white = this.setupLamp(new THREE.MeshStandardMaterial(), 0x2a2a26, 0xf4f1de);
      const redLamp = new THREE.Mesh(this.shuntLensGeo, red);
      redLamp.position.set(0.14, 1.24, 0.1);
      const w1 = new THREE.Mesh(this.shuntLensGeo, white);
      w1.position.set(-0.14, 1.24, 0.1);
      const w2 = new THREE.Mesh(this.shuntLensGeo, white);
      w2.position.set(0.14, 1.52, 0.1);
      obj.add(redLamp, w1, w2);
      this.group.add(obj);

      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          opacity: 0,
        }),
      );
      glow.scale.setScalar(1.9);
      const lampPos = pos.clone();
      lampPos.y += 1.38;
      lampPos.x += -tx * 0.25;
      lampPos.z += -tz * 0.25;
      glow.position.copy(lampPos);
      this.group.add(glow);
      this.signals.set(key, { key, type, lamps: { red, white }, glow, pos: lampPos });
      return;
    }

    if (type === 'distant') {
      const pos = new THREE.Vector3(node.x + -tz * 2.9 - tx * 3, node.y - 0.55, node.z + tx * 2.9 - tz * 3);
      const obj = new THREE.Group();
      obj.position.copy(pos);
      obj.rotation.y = yaw;
      const base = new THREE.Mesh(this.distantBaseGeo, this.concreteMat);
      base.position.y = 0.18;
      const post = new THREE.Mesh(this.distantPostGeo, this.darkSteelMat);
      post.position.y = 2.45;
      post.castShadow = true;
      obj.add(base, post);
      for (const by of [1.1, 2.0, 2.9, 3.8]) {
        const band = new THREE.Mesh(this.distantBandGeo, this.amberPaintMat);
        band.position.y = by;
        obj.add(band);
      }
      const diamond = new THREE.Mesh(this.distantDiamondGeo, this.darkSteelMat);
      diamond.position.set(0, 2.45, 0.09);
      diamond.rotation.z = Math.PI / 4;
      const diamondIn = new THREE.Mesh(this.distantDiamondInnerGeo, this.amberPaintMat);
      diamondIn.position.set(0, 2.45, 0.1);
      diamondIn.rotation.z = Math.PI / 4;
      const head = new THREE.Mesh(this.distantHeadGeo, this.darkSteelMat);
      head.position.set(0, 4.75, 0.08);
      head.castShadow = true;
      obj.add(diamond, diamondIn, head);

      const yellow = this.setupLamp(new THREE.MeshStandardMaterial(), 0x2a1d06, 0xffa010);
      const green = this.setupLamp(new THREE.MeshStandardMaterial(), 0x062a14, 0x18ff78);
      const amberLamp = new THREE.Mesh(this.distantLensGeo, yellow);
      amberLamp.position.set(0, 4.95, 0.16);
      const greenLamp = new THREE.Mesh(this.distantLensGeo, green);
      greenLamp.position.set(0, 4.55, 0.16);
      for (const hy of [5.09, 4.69]) {
        const hood = new THREE.Mesh(this.hoodGeo, this.darkSteelMat);
        hood.position.set(0, hy, 0.28);
        obj.add(hood);
      }
      obj.add(amberLamp, greenLamp);
      this.group.add(obj);

      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          opacity: 0,
        }),
      );
      glow.scale.setScalar(2.6);
      const lampPos = pos.clone();
      lampPos.y += 4.75;
      lampPos.x += -tx * 0.25;
      lampPos.z += -tz * 0.25;
      glow.position.copy(lampPos);
      this.group.add(glow);
      this.signals.set(key, { key, type, lamps: { yellow, green }, glow, pos: lampPos });
      return;
    }

    // Standard 3-aspect main signal, plus an original lit route indicator when protecting a facing junction.
    const obj = this.assets.clone('signal_mast');
    const pos = new THREE.Vector3(node.x + -tz * 2.9 - tx * 3, node.y - 0.55, node.z + tx * 2.9 - tz * 3);
    obj.position.copy(pos);
    // The lamps face oncoming trains, opposite the direction of travel.
    obj.rotation.y = yaw;
    const lamps = {
      red: this.setupLamp(new THREE.MeshStandardMaterial(), 0x2a0606, 0xff1a10),
      yellow: this.setupLamp(new THREE.MeshStandardMaterial(), 0x2a1d06, 0xffa010),
      green: this.setupLamp(new THREE.MeshStandardMaterial(), 0x062a14, 0x18ff78),
    };
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (o.name.startsWith('lamp_red')) m.material = lamps.red;
      if (o.name.startsWith('lamp_amber')) m.material = lamps.yellow;
      if (o.name.startsWith('lamp_green')) m.material = lamps.green;
    });

    let routeVis: SignalVisual['route'];
    if (hasFacingJunctionInBlock(net, node.id, side)) {
      const rGroup = new THREE.Group();
      rGroup.position.set(0, 5.82, 0.08);
      const trim = new THREE.Mesh(this.routeTrimGeo, this.brassMat);
      const rBox = new THREE.Mesh(this.routeBoxGeo, this.darkSteelMat);
      rGroup.add(trim, rBox);

      const leftMat = this.setupLamp(new THREE.MeshStandardMaterial(), 0x1b1d1e, 0xf4f1de);
      const rightMat = this.setupLamp(new THREE.MeshStandardMaterial(), 0x1b1d1e, 0xf4f1de);
      for (const [isRight, mat] of [
        [false, leftMat],
        [true, rightMat],
      ] as const) {
        const sgn = isRight ? 1 : -1;
        for (let d = 0; d < 4; d++) {
          const dot = new THREE.Mesh(this.featherDotGeo, mat);
          dot.position.set(sgn * (0.16 + d * 0.08), -0.1 + d * 0.09, 0.08);
          rGroup.add(dot);
        }
      }
      const numMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xf4f1de,
        emissiveIntensity: 0,
        roughness: 0.3,
      });
      this.owned.push(numMat);
      const numMesh = new THREE.Mesh(this.routeNumGeo, numMat);
      numMesh.position.set(0, 0, 0.082);
      rGroup.add(numMesh);

      obj.add(rGroup);
      routeVis = { left: leftMat, right: rightMat, numMat, lastKey: '' };
    }

    this.group.add(obj);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTex,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      }),
    );
    glow.scale.setScalar(2.6);
    const lampPos = pos.clone();
    lampPos.y += 4.75;
    lampPos.x += -tx * 0.25;
    lampPos.z += -tz * 0.25;
    glow.position.copy(lampPos);
    this.group.add(glow);
    this.signals.set(key, { key, type, lamps, route: routeVis, glow, pos: lampPos });
  }

  private addLever(node: RailNode, side: Side) {
    const obj = this.assets.clone('switch_stand');
    const tx = node.dx * side;
    const tz = node.dz * side;
    const pos = new THREE.Vector3(node.x - -tz * 3.1, node.y - 0.6, node.z - tx * 3.1);
    obj.position.copy(pos);
    obj.rotation.y = Math.atan2(tx, tz);
    // Painted target that turns with the switch position.
    const armMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    this.owned.push(armMat);
    const arm = new THREE.Mesh(this.armGeo, armMat);
    arm.position.y = 1.35;
    obj.add(arm);
    this.group.add(obj);
    this.levers.set(keyOf(node.id, side), { arm, node: node.id, side });
  }

  private addBuffer(node: RailNode, side: Side) {
    // A dead end on this side: the buffer stop faces back along the track.
    const obj = this.assets.clone('buffer_stop');
    const tx = node.dx * side;
    const tz = node.dz * side;
    obj.position.set(node.x, node.y - 0.25, node.z);
    obj.rotation.y = Math.atan2(-tx, -tz);
    this.group.add(obj);
  }

  private addStation(net: Network, st: Station) {
    const node = net.nodes.get(st.nodeId);
    if (!node) return;
    const halfLen = st.length / 2;
    const seg1 = net.attached(node.id, 1);
    const seg2 = net.attached(node.id, -1);
    // Sample the track through the station so platforms follow gentle curves.
    const frames: { x: number; y: number; z: number; tx: number; tz: number }[] = [];
    const walk = (segs: number[], fromSide: Side, sign: number) => {
      if (!segs.length) return;
      const segId = segs[0];
      const seg = net.segs.get(segId)!;
      const L = net.geom.get(segId)!.length;
      const forward = seg.a === node.id && seg.sa === fromSide;
      for (let d = sign > 0 ? 5 : 15; d < halfLen; d += 10) {
        if (d > L) break;
        const p = net.sample(segId, forward ? d : L - d);
        const flip = forward ? 1 : -1;
        frames.push({ x: p.x, y: p.y, z: p.z, tx: p.tx * flip * fromSide, tz: p.tz * flip * fromSide });
      }
    };
    walk(seg1, 1, 1);
    walk(seg2, -1, -1);
    if (!frames.length) return;

    const instances: THREE.Matrix4[] = [];
    const t = new THREE.Object3D();
    const offset = 1.6 + 2.3;
    for (const f of frames) {
      const rx = -f.tz * st.platformSide;
      const rz = f.tx * st.platformSide;
      t.position.set(f.x + rx * offset, f.y - 0.05, f.z + rz * offset);
      // Tile local +X is the track edge, which must point back at the rails.
      t.rotation.y = Math.atan2(rx, rz) + Math.PI / 2;
      t.updateMatrix();
      instances.push(t.matrix.clone());
    }
    for (const prim of this.assets.primitives('platform')) {
      const inst = new THREE.InstancedMesh(prim.geometry, prim.material, instances.length);
      instances.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      this.group.add(inst);
    }

    const rx = -node.dz * st.platformSide;
    const rz = node.dx * st.platformSide;
    const y = node.y + 1.0;
    const yaw = Math.atan2(rx, rz) + Math.PI / 2;
    const place = (name: string, along: number, lateral: number, yOff = 0, yawOff = 0) => {
      const obj = this.assets.clone(name);
      obj.position.set(node.x + node.dx * along + rx * lateral, y + yOff, node.z + node.dz * along + rz * lateral);
      obj.rotation.y = yaw + yawOff;
      this.group.add(obj);
      return obj;
    };
    place('station_building', 4, 14.2, -0.08);
    for (const along of [-42, 42]) place('shelter', along, offset - 0.1);
    // Lamps on the platform; the nearest few get real point lights.
    for (let along = -st.length / 2 + 12; along < st.length / 2 - 4; along += 26) {
      place('lamp_post', along, offset - 1.2);
      const yawR = yaw;
      this.lamps.push(
        new THREE.Vector3(
          node.x + node.dx * along + rx * (offset - 1.2) + Math.cos(yawR) * 0.75,
          y + 4.5,
          node.z + node.dz * along + rz * (offset - 1.2) - Math.sin(yawR) * 0.75,
        ),
      );
    }
    // Name board.
    const boardMat = new THREE.MeshStandardMaterial({
      map: signTexture(st.name),
      roughness: 0.5,
      emissive: 0xffffff,
      emissiveIntensity: 0,
      side: THREE.DoubleSide,
    });
    this.owned.push(boardMat, boardMat.map!);
    const board = new THREE.Mesh(this.boardGeo, boardMat);
    board.position.set(
      node.x + node.dx * 16 + rx * (offset + 0.2),
      y + 2.5,
      node.z + node.dz * 16 + rz * (offset + 0.2),
    );
    board.rotation.y = Math.atan2(-rx, -rz);
    this.group.add(board);
    for (const leg of [-2.8, 2.8]) {
      const post = new THREE.Mesh(this.postGeo, this.postMat);
      post.position.set(board.position.x + node.dx * leg, y + 1.25, board.position.z + node.dz * leg);
      this.group.add(post);
    }
  }

  /** Lamp states, route indicators, speed board night glow, lever flags and the nearest platform lights. */
  update(sim: Sim, camera: THREE.Camera, night: number) {
    const net = sim.net;
    for (const v of this.signals.values()) {
      const ind = sim.indications.get(v.key);
      const aspect = ind?.aspect ?? sim.aspects.get(v.key) ?? 'red';
      const calling = ind?.callingOn ?? false;
      const stateKey = `${aspect}:${calling ? 1 : 0}`;
      if (stateKey !== v.last) {
        v.last = stateKey;
        if (v.type === 'shunt') {
          if (v.lamps.red) v.lamps.red.emissiveIntensity = aspect === 'red' ? LAMP_INTENSITY.red : 0;
          if (v.lamps.white) v.lamps.white.emissiveIntensity = aspect !== 'red' ? LAMP_INTENSITY.white : 0;
          v.glow.material.color.set(aspect === 'red' ? 0xff2a18 : 0xf4f1de);
        } else {
          if (v.lamps.red) v.lamps.red.emissiveIntensity = aspect === 'red' ? LAMP_INTENSITY.red : 0;
          if (v.lamps.yellow) v.lamps.yellow.emissiveIntensity = aspect === 'yellow' ? LAMP_INTENSITY.yellow : 0;
          if (v.lamps.green) v.lamps.green.emissiveIntensity = aspect === 'green' ? LAMP_INTENSITY.green : 0;
          v.glow.material.color.set(aspect === 'red' ? 0xff2a18 : aspect === 'yellow' ? 0xffa820 : 0x30ff88);
        }
      }
      if (v.route) {
        const route = aspect !== 'red' && ind?.route?.diverging ? ind.route : null;
        const dir = route ? route.dir : 'off';
        const num = route ? route.index + 1 : 0;
        const rKey = `${dir}:${num}`;
        if (rKey !== v.route.lastKey) {
          v.route.lastKey = rKey;
          v.route.left.emissiveIntensity = dir === 'left' ? 14 : 0;
          v.route.right.emissiveIntensity = dir === 'right' ? 14 : 0;
          if (num > 0) {
            let tex = this.routeTex.get(num);
            if (!tex) {
              tex = routeNumTexture(num);
              this.routeTex.set(num, tex);
            }
            v.route.numMat.color.setHex(0xffffff);
            v.route.numMat.map = tex;
            v.route.numMat.emissiveMap = tex;
            v.route.numMat.emissiveIntensity = 4;
            v.route.numMat.needsUpdate = true;
          } else {
            v.route.numMat.map = null;
            v.route.numMat.emissiveMap = null;
            v.route.numMat.emissiveIntensity = 0;
            v.route.numMat.color.setHex(0x0e1315);
            v.route.numMat.needsUpdate = true;
          }
        }
      }
      v.glow.material.opacity = 0.15 + night * 0.75;
    }
    const boardEmissive = 0.14 + night * 0.48;
    for (const m of this.speedMats) m.emissiveIntensity = boardEmissive;
    for (const lever of this.levers.values()) {
      const { node, side } = lever;
      const opts = net.attached(node, side);
      if (!opts.length) continue;
      const idx = opts.indexOf(net.selected(node, side)!);
      lever.arm.rotation.y = idx === 0 ? 0 : Math.PI / 2;
      ((lever.arm as THREE.Mesh).material as THREE.MeshStandardMaterial).color.set(idx === 0 ? 0x32c46c : 0xe8a820);
    }

    const camPos = camera.position;
    const on = night > 0.25;
    if (on && this.lamps.length) {
      if (this.nearLamps.length !== this.lamps.length || this.sortedAt.distanceToSquared(camPos) > 25 * 25) {
        if (this.nearLamps.length !== this.lamps.length) this.nearLamps = [...this.lamps];
        this.nearLamps.sort((a, b) => a.distanceToSquared(camPos) - b.distanceToSquared(camPos));
        this.sortedAt.copy(camPos);
      }
      const sorted = this.nearLamps;
      this.lightPool.forEach((l, i) => {
        const p = sorted[i];
        if (p && p.distanceTo(camPos) < 500) {
          l.position.copy(p);
          l.intensity = 70 * night;
        } else l.intensity = 0;
      });
    } else {
      for (const l of this.lightPool) l.intensity = 0;
    }
  }
}
