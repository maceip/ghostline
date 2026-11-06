/**
 * field.js — the residual-stream hero field (three.js).
 *
 * 24 decoder-layer rings, a particle stream flowing up through them, a harm
 * axis that lights on a harmful scenario, and the signature gesture: when a
 * call is BLOCKED the stream dies at the probe ring; when PASSED it continues.
 *
 * No post-processing, no glow chrome (nothing-design): brightness is opacity.
 */
import * as THREE from "../vendor/three.module.js";

const RINGS = 24;
const PROBE = 16;

export class ResidualField {
  constructor(canvas) {
    this.canvas = canvas;
    this.blocked = false;
    this.harm = 0; // 0..1 harm axis strength
    this.pointer = new THREE.Vector2(0, 0);
    this.targetPointer = new THREE.Vector2(0, 0);
    this.reduced =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(2.3, 1.5, 6.6);
    this.camera.lookAt(0, 0.55, 0);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.ringGroup = new THREE.Group();
    this.root.add(this.ringGroup);
    this._buildRings();

    this.stream = this._buildStream();
    this.root.add(this.stream.points);

    this.axis = this._buildAxis();
    this.root.add(this.axis);

    this.grid = this._buildGrid();
    this.root.add(this.grid);

    this.resize();
    window.addEventListener("resize", () => this.resize());
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.targetPointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        ((e.clientY - r.top) / r.height) * 2 - 1
      );
    });

    this.t0 = performance.now();
    this._raf = null;
    this._running = false;
  }

  _ringY(i) {
    return (i / (RINGS - 1)) * 3.4 - 1.5;
  }

  _buildRings() {
    const neutral = new THREE.LineBasicMaterial({
      color: 0x3a3a3a,
      transparent: true,
      opacity: 0.55,
    });
    const probeMat = new THREE.LineBasicMaterial({
      color: 0xd71921,
      transparent: true,
      opacity: 1,
    });
    this.ringMeshes = [];
    for (let i = 0; i < RINGS; i++) {
      const y = this._ringY(i);
      const r = 1.55 + Math.sin(i * 0.35) * 0.05;
      const pts = [];
      const seg = 110;
      for (let s = 0; s <= seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, i === PROBE ? probeMat.clone() : neutral.clone());
      line.userData.layer = i;
      line.userData.baseOpacity = i === PROBE ? 1 : 0.3 + (i / RINGS) * 0.35;
      line.material.opacity = line.userData.baseOpacity;
      this.ringGroup.add(line);
      this.ringMeshes.push(line);

      if (i === PROBE) {
        // bright tick beads on the probe ring
        const tickGeo = new THREE.BufferGeometry();
        const count = 72;
        const tickPos = new Float32Array(count * 3);
        for (let s = 0; s < count; s++) {
          const a = (s / count) * Math.PI * 2;
          tickPos[s * 3] = Math.cos(a) * r;
          tickPos[s * 3 + 1] = y;
          tickPos[s * 3 + 2] = Math.sin(a) * r;
        }
        tickGeo.setAttribute("position", new THREE.BufferAttribute(tickPos, 3));
        this.probeBeads = new THREE.Points(
          tickGeo,
          new THREE.PointsMaterial({
            color: 0xff2a2a,
            size: 0.05,
            transparent: true,
            opacity: 1,
            sizeAttenuation: true,
          })
        );
        this.ringGroup.add(this.probeBeads);

        // thin secondary halo ring just above the probe
        const halo = [];
        for (let s = 0; s <= seg; s++) {
          const a = (s / seg) * Math.PI * 2;
          halo.push(new THREE.Vector3(Math.cos(a) * (r + 0.12), y + 0.02, Math.sin(a) * (r + 0.12)));
        }
        this.haloRing = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(halo),
          new THREE.LineBasicMaterial({ color: 0xd71921, transparent: true, opacity: 0.35 })
        );
        this.ringGroup.add(this.haloRing);
      }
    }
  }

  _buildStream() {
    const N = 5200;
    const positions = new Float32Array(N * 3);
    const speeds = new Float32Array(N);
    const seeds = new Float32Array(N);
    const radius = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 1.42;
      radius[i] = r;
      seeds[i] = a;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = Math.random() * 3.4 - 1.5;
      positions[i * 3 + 2] = Math.sin(a) * r;
      speeds[i] = 0.12 + Math.random() * 0.38;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xf2f2f2,
      size: 0.03,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    return { points, positions, speeds, seeds, radius, N };
  }

  _buildAxis() {
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({
      color: 0xd71921,
      transparent: true,
      opacity: 0,
    });
    // double-line beam for weight
    const mk = (off) => {
      const pts = [
        new THREE.Vector3(-1.9 + off, -1.6, -0.2),
        new THREE.Vector3(1.9 + off, 1.95, 0.2),
      ];
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    };
    g.add(mk(-0.035), mk(0.035));

    const head = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.32, 12),
      new THREE.MeshBasicMaterial({ color: 0xd71921, transparent: true, opacity: 0 })
    );
    head.position.set(2.0, 2.05, 0.22);
    head.rotation.z = -Math.PI / 4;
    g.add(head);

    // origin dot
    const origin = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xd71921, transparent: true, opacity: 0 })
    );
    origin.position.set(-1.95, -1.65, -0.2);
    g.add(origin);

    g.userData = {
      lineMat: mat,
      headMat: head.material,
      originMat: origin.material,
    };
    return g;
  }

  _buildGrid() {
    const pts = [];
    const y = -1.58;
    for (let i = -6; i <= 6; i++) {
      pts.push(new THREE.Vector3(i * 0.55, y, -3.2), new THREE.Vector3(i * 0.55, y, 3.2));
      pts.push(new THREE.Vector3(-3.2, y, i * 0.55), new THREE.Vector3(3.2, y, i * 0.55));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0x161616, transparent: true, opacity: 1 })
    );
  }

  /** Set judging state from a real verdict. */
  setState({ blocked = false, harm = 0 } = {}) {
    this.blocked = !!blocked;
    this.harm = Math.max(0, Math.min(1, harm));
  }

  resize() {
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth || 640;
    const h = this.canvas.clientHeight || 480;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      this._frame();
    };
    loop();
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _frame() {
    const t = (performance.now() - this.t0) / 1000;
    const s = this.stream;
    const probeY = this._ringY(PROBE);

    const pos = s.positions;
    for (let i = 0; i < s.N; i++) {
      let y = pos[i * 3 + 1];
      const speed = this.reduced ? 0.02 : s.speeds[i];
      if (this.blocked && y > probeY - 0.02) {
        // pile into a disc just under the probe ring, then respawn below
        const target = probeY - 0.06 - (s.seeds[i] % 0.14);
        y += (target - y) * 0.12;
        if (Math.random() < 0.002) {
          y = -1.55;
          const a = s.seeds[i] + t * 0.05;
          const r = s.radius[i];
          pos[i * 3] = Math.cos(a) * r;
          pos[i * 3 + 2] = Math.sin(a) * r;
        }
      } else {
        y += speed * 0.017;
        if (y > 1.95) {
          y = -1.55;
          const a = s.seeds[i] + t * 0.05;
          const r = s.radius[i];
          pos[i * 3] = Math.cos(a) * r;
          pos[i * 3 + 2] = Math.sin(a) * r;
        }
      }
      pos[i * 3 + 1] = y;
    }
    s.points.geometry.attributes.position.needsUpdate = true;

    // above-probe stream dims when blocked; the pile stays bright
    s.points.material.opacity = this.blocked ? 0.42 : 0.55;

    // ring reaction
    this.ringMeshes.forEach((ring, i) => {
      const d = Math.abs(i - PROBE);
      const near = Math.max(0, 1 - d / 7);
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4 - d * 0.45);
      const boost = this.harm * near * pulse * 0.55;
      ring.material.opacity = Math.min(1, ring.userData.baseOpacity + boost);
    });

    if (this.probeBeads) {
      const pulse = 0.6 + 0.4 * Math.sin(t * 3);
      this.probeBeads.material.size = 0.045 + this.harm * 0.03 * pulse;
      this.probeBeads.material.opacity = 0.75 + this.harm * 0.25;
    }
    if (this.haloRing) {
      this.haloRing.material.opacity = 0.18 + this.harm * 0.45;
    }

    // harm axis
    const a = this.axis.userData;
    const target = this.harm * 0.85;
    a.lineMat.opacity += (target - a.lineMat.opacity) * 0.08;
    a.headMat.opacity = a.lineMat.opacity;
    a.originMat.opacity = a.lineMat.opacity;

    // camera parallax + slow drift
    this.pointer.lerp(this.targetPointer, 0.05);
    const px = this.pointer.x;
    const py = this.pointer.y;
    if (!this.reduced) {
      this.camera.position.x = 2.3 + px * 0.55;
      this.camera.position.y = 1.5 - py * 0.35;
      this.camera.lookAt(0, 0.55, 0);
      this.root.rotation.y = Math.sin(t * 0.12) * 0.07 + px * 0.05;
    }

    this.renderer.render(this.scene, this.camera);
  }
}
