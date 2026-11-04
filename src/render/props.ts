// Lineside objects driven by the network: signals, point levers, buffer stops, stations and their lights.
import * as THREE from 'three';

import type { Network, RailNode, Side, Station } from '../rail/network';
import type { Sim } from '../rail/sim';
import { keyOf } from '../rail/sim';
import type { Assets } from './assets';

const LAMP_INTENSITY = { red: 26, yellow: 22, green: 16 };

interface SignalVisual {
  key: string;
  lamps: { red: THREE.MeshStandardMaterial; yellow: THREE.MeshStandardMaterial; green: THREE.MeshStandardMaterial };
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

export class PropsRenderer {
  group = new THREE.Group();
  private signals = new Map<string, SignalVisual>();
  private lastVersion = -1;
  private lamps: THREE.Vector3[] = [];
  private lightPool: THREE.PointLight[] = [];
  private glowTex = glowTexture();
  private levers = new Map<string, { arm: THREE.Object3D }>();
  // Shared by every rebuild, so never disposed when props are cleared.
  private armGeo = new THREE.BoxGeometry(0.46, 0.46, 0.04);
  private boardGeo = new THREE.PlaneGeometry(6.4, 1.2);
  private postGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.5, 6);
  private postMat = new THREE.MeshStandardMaterial({ color: 0x25292c, roughness: 0.6 });
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
    this.signals.clear();
    this.levers.clear();
    this.lamps = [];
  }

  private rebuild(net: Network) {
    this.clearGroup();
    for (const node of net.nodes.values()) {
      for (const side of [1, -1] as Side[]) {
        if (node.signals[side]) this.addSignal(node, side);
        const opts = net.attached(node.id, side);
        if (opts.length > 1) this.addLever(node, side);
        if (opts.length === 0 && net.attached(node.id, -side as Side).length > 0) this.addBuffer(node, side);
      }
    }
    for (const st of net.stations) this.addStation(net, st);
  }

  private addSignal(node: RailNode, side: Side) {
    const obj = this.assets.clone('signal_mast');
    const tx = node.dx * side;
    const tz = node.dz * side;
    const pos = new THREE.Vector3(node.x + -tz * 2.9 - tx * 3, node.y - 0.55, node.z + tx * 2.9 - tz * 3);
    obj.position.copy(pos);
    // The lamps face oncoming trains, opposite the direction of travel.
    obj.rotation.y = Math.atan2(-tx, -tz);
    const lamps = {
      red: new THREE.MeshStandardMaterial(),
      yellow: new THREE.MeshStandardMaterial(),
      green: new THREE.MeshStandardMaterial(),
    };
    const setup = (mat: THREE.MeshStandardMaterial, color: number, emissive: number) => {
      mat.color.set(color);
      mat.emissive.set(emissive);
      mat.roughness = 0.25;
      mat.emissiveIntensity = 0;
    };
    this.owned.push(lamps.red, lamps.yellow, lamps.green);
    setup(lamps.red, 0x2a0606, 0xff1a10);
    setup(lamps.yellow, 0x2a1d06, 0xffa010);
    setup(lamps.green, 0x062a14, 0x18ff78);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (o.name.startsWith('lamp_red')) m.material = lamps.red;
      if (o.name.startsWith('lamp_amber')) m.material = lamps.yellow;
      if (o.name.startsWith('lamp_green')) m.material = lamps.green;
    });
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
    this.signals.set(keyOf(node.id, side), { key: keyOf(node.id, side), lamps, glow, pos: lampPos });
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
    this.levers.set(keyOf(node.id, side), { arm });
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

  /** Lamp states, lever flags and the nearest platform lights. */
  update(sim: Sim, camera: THREE.Camera, night: number) {
    const net = sim.net;
    for (const v of this.signals.values()) {
      const aspect = sim.aspects.get(v.key) ?? 'red';
      if (aspect !== v.last) {
        v.last = aspect;
        v.lamps.red.emissiveIntensity = aspect === 'red' ? LAMP_INTENSITY.red : 0;
        v.lamps.yellow.emissiveIntensity = aspect === 'yellow' ? LAMP_INTENSITY.yellow : 0;
        v.lamps.green.emissiveIntensity = aspect === 'green' ? LAMP_INTENSITY.green : 0;
        const mat = v.glow.material;
        mat.color.set(aspect === 'red' ? 0xff2a18 : aspect === 'yellow' ? 0xffa820 : 0x30ff88);
      }
      v.glow.material.opacity = 0.15 + night * 0.75;
    }
    for (const [key, lever] of this.levers) {
      const [nid, sideStr] = key.split(':');
      const node = Number(nid);
      const side = Number(sideStr) as Side;
      const opts = net.attached(node, side);
      if (!opts.length) continue;
      const idx = opts.indexOf(net.selected(node, side)!);
      lever.arm.rotation.y = idx === 0 ? 0 : Math.PI / 2;
      ((lever.arm as THREE.Mesh).material as THREE.MeshStandardMaterial).color.set(idx === 0 ? 0x32c46c : 0xe8a820);
    }

    const camPos = camera.position;
    const on = night > 0.25;
    if (on && this.lamps.length) {
      const sorted = [...this.lamps].sort((a, b) => a.distanceToSquared(camPos) - b.distanceToSquared(camPos));
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
