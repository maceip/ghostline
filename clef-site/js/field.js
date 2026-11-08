/**
 * field.js — the residual-stream hero field (three.js).
 *
 * 24 decoder-layer rings (Qwen2.5-0.5B-Instruct), a continuous upward particle
 * stream representing token residual activations, an internal LAT (Linear
 * Artificial Tomography) hexagonal subspace reticle inside Layer 16, and
 * Representation Rerouting: when a tool call is BLOCKED at Layer 16 (68% depth),
 * harmful subspace components deflect radially along the +v_harm contrast axis
 * while the orthogonalized stream continues upward — eliminating any hollow
 * "black hole" void or grey pancake fog below the probe ring.
 */
import * as THREE from "../vendor/three.module.js";

const RINGS = 24;
const PROBE = 16;

const PALETTES = {
  dark: {
    ring: 0x2c2c2c,
    ringInner: 0x242424,
    spine: 0x383838,
    probe: 0xd71921,
    probeBead: 0xff3b30,
    streamSafe: new THREE.Color(0xd8d8d8),
    streamMint: new THREE.Color(0x00d66b),
    streamHarm: new THREE.Color(0xff2e36),
    grid: 0x121212,
    axis: 0xd71921,
  },
  light: {
    ring: 0xc8c8c8,
    ringInner: 0xd4d4d4,
    spine: 0xb0b0b0,
    probe: 0xd71921,
    probeBead: 0xd71921,
    streamSafe: new THREE.Color(0x222222),
    streamMint: new THREE.Color(0x008a45),
    streamHarm: new THREE.Color(0xd71921),
    grid: 0xe4e4e4,
    axis: 0xd71921,
  },
};

export class ResidualField {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.blocked = false;
    this.harm = 0; // 0..1 harm axis strength
    this.pointer = new THREE.Vector2(0, 0);
    this.targetPointer = new THREE.Vector2(0, 0);
    this.theme = opts.theme === "light" ? "light" : "dark";
    this.colors = PALETTES[this.theme];
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
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.position.set(2.25, 1.38, 6.55);
    this.camera.lookAt(0, 0.35, 0);

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
    return (i / (RINGS - 1)) * 3.4 - 1.55;
  }

  _circleLine(radius, y, segments, material) {
    const pts = [];
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius));
    }
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material);
  }

  _buildRings() {
    this.ringMeshes = [];
    this.innerReticleLines = [];
    const seg = 112;

    // Central residual spine (d_model = 896 vertical axis through all 24 layers)
    const spinePts = [
      new THREE.Vector3(0, this._ringY(0) - 0.15, 0),
      new THREE.Vector3(0, this._ringY(RINGS - 1) + 0.25, 0),
    ];
    this.spineLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(spinePts),
      new THREE.LineBasicMaterial({
        color: this.colors.spine,
        transparent: true,
        opacity: 0.55,
      })
    );
    this.ringGroup.add(this.spineLine);

    for (let i = 0; i < RINGS; i++) {
      const y = this._ringY(i);
      const r = 1.52 + Math.sin(i * 0.32) * 0.04;
      const isProbe = i === PROBE;

      const mat = new THREE.LineBasicMaterial({
        color: isProbe ? this.colors.probe : this.colors.ring,
        transparent: true,
        opacity: isProbe ? 1.0 : 0.34 + (i / RINGS) * 0.24,
      });

      const line = this._circleLine(r, y, seg, mat);
      line.userData.layer = i;
      line.userData.baseOpacity = mat.opacity;
      this.ringGroup.add(line);
      this.ringMeshes.push(line);

      // Subtle inner concentric ring every 4 layers so the cylinder interior has uniform depth
      if (!isProbe && i % 4 === 0) {
        const innerMat = new THREE.LineBasicMaterial({
          color: this.colors.ringInner,
          transparent: true,
          opacity: 0.22,
        });
        const inner = this._circleLine(r * 0.52, y, 72, innerMat);
        this.ringGroup.add(inner);
        this.innerReticleLines.push(inner);
      }

      if (isProbe) {
        // LAT Subspace Reticle inside Layer 16 (prevents any hollow dark hole inside the probe circle)
        const probeSubMat1 = new THREE.LineBasicMaterial({
          color: this.colors.probe,
          transparent: true,
          opacity: 0.42,
        });
        const probeSubMat2 = new THREE.LineBasicMaterial({
          color: this.colors.probe,
          transparent: true,
          opacity: 0.28,
        });
        this.probeInnerRing1 = this._circleLine(r * 0.66, y, 96, probeSubMat1);
        this.probeInnerRing2 = this._circleLine(r * 0.33, y, 72, probeSubMat2);
        this.ringGroup.add(this.probeInnerRing1, this.probeInnerRing2);

        // 6-axis hexagonal tomography spokes matching the AgentVector / Clef geometry
        const spokePts = [];
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          spokePts.push(
            new THREE.Vector3(0, y, 0),
            new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)
          );
        }
        this.probeSpokes = new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(spokePts),
          new THREE.LineBasicMaterial({
            color: this.colors.probe,
            transparent: true,
            opacity: 0.32,
          })
        );
        this.ringGroup.add(this.probeSpokes);

        // Tick beads around the Layer 16 perimeter + inner subspace nodes
        const tickCount = 72;
        const innerNodes = 13; // center + 6 mid + 6 outer hex vertices
        const totalBeads = tickCount + innerNodes;
        const tickPos = new Float32Array(totalBeads * 3);
        for (let s = 0; s < tickCount; s++) {
          const a = (s / tickCount) * Math.PI * 2;
          tickPos[s * 3] = Math.cos(a) * r;
          tickPos[s * 3 + 1] = y;
          tickPos[s * 3 + 2] = Math.sin(a) * r;
        }
        // Center node at (0, y, 0)
        let idx = tickCount;
        tickPos[idx * 3] = 0;
        tickPos[idx * 3 + 1] = y;
        tickPos[idx * 3 + 2] = 0;
        idx++;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          tickPos[idx * 3] = Math.cos(a) * (r * 0.33);
          tickPos[idx * 3 + 1] = y;
          tickPos[idx * 3 + 2] = Math.sin(a) * (r * 0.33);
          idx++;
          tickPos[idx * 3] = Math.cos(a) * (r * 0.66);
          tickPos[idx * 3 + 1] = y;
          tickPos[idx * 3 + 2] = Math.sin(a) * (r * 0.66);
          idx++;
        }

        const tickGeo = new THREE.BufferGeometry();
        tickGeo.setAttribute("position", new THREE.BufferAttribute(tickPos, 3));
        this.probeBeads = new THREE.Points(
          tickGeo,
          new THREE.PointsMaterial({
            color: this.colors.probeBead,
            size: 0.048,
            transparent: true,
            opacity: 0.95,
            sizeAttenuation: true,
          })
        );
        this.ringGroup.add(this.probeBeads);

        // Outer halo ring
        this.haloRing = this._circleLine(
          r + 0.11,
          y + 0.015,
          seg,
          new THREE.LineBasicMaterial({
            color: this.colors.probe,
            transparent: true,
            opacity: 0.35,
          })
        );
        this.ringGroup.add(this.haloRing);
      }
    }
  }

  _buildStream() {
    // Balanced particle count so upward motion is crisp without creating a grey fog below the ring
    const N = 2200;
    const positions = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const speeds = new Float32Array(N);
    const seeds = new Float32Array(N);
    const radius = new Float32Array(N);
    const role = new Uint8Array(N); // 0 = core stream (always flows through all 24 layers), 1 = contrast-sensitive component

    const cSafe = this.colors.streamSafe;
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      // Distribute particles across the inner core AND outer ring so the center of the circle is never empty
      const u = Math.random();
      const r = u < 0.45 ? Math.sqrt(Math.random()) * 0.68 : 0.35 + Math.sqrt(Math.random()) * 1.12;
      radius[i] = r;
      seeds[i] = a;
      role[i] = i % 3 === 0 ? 1 : 0; // 33% deflect along +v_harm when blocked; 67% continue upward through layers 17..23
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = Math.random() * 3.55 - 1.55;
      positions[i * 3 + 2] = Math.sin(a) * r;
      speeds[i] = 0.22 + Math.random() * 0.42;

      colors[i * 3] = cSafe.r;
      colors[i * 3 + 1] = cSafe.g;
      colors[i * 3 + 2] = cSafe.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.034,
      vertexColors: true,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    return { points, positions, colors, speeds, seeds, radius, role, N };
  }

  _buildAxis() {
    // Precision LAT Reading Vector (+v_harm) anchored on the Layer 16 probe plane
    // Rising upward and outward at a clean 28-degree angle from the Layer 16 center (0, probeY, 0)
    const g = new THREE.Group();
    const probeY = this._ringY(PROBE);
    const dir = new THREE.Vector3(1.55, 0.92, 0.28).normalize();
    const len = 2.15;
    const start = new THREE.Vector3(0, probeY, 0);
    const end = start.clone().addScaledVector(dir, len);

    const lineMat = new THREE.LineBasicMaterial({
      color: this.colors.axis,
      transparent: true,
      opacity: 0.35,
    });

    const mkShaft = (offsetVec) => {
      const pts = [start.clone().add(offsetVec), end.clone().add(offsetVec)];
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
    };
    g.add(
      mkShaft(new THREE.Vector3(0, 0.018, 0)),
      mkShaft(new THREE.Vector3(0, -0.018, 0))
    );

    // Sleek, accurately oriented vector arrowhead aligned with `dir`
    const headGeo = new THREE.ConeGeometry(0.068, 0.22, 16);
    const headMat = new THREE.MeshBasicMaterial({
      color: this.colors.axis,
      transparent: true,
      opacity: 0.35,
    });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.copy(end);
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.add(head);

    // Center origin node on Layer 16
    const origin = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 12, 12),
      new THREE.MeshBasicMaterial({
        color: this.colors.axis,
        transparent: true,
        opacity: 0.45,
      })
    );
    origin.position.copy(start);
    g.add(origin);

    g.userData = {
      lineMat,
      headMat,
      originMat: origin.material,
      dir,
      probeY,
    };
    return g;
  }

  _buildGrid() {
    // Minimal outer calibration ticks at Layer 0 base so the lower region never has a grey haze
    const pts = [];
    const y = -1.62;
    const rInner = 1.65;
    const rOuter = 2.05;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      pts.push(
        new THREE.Vector3(Math.cos(a) * rInner, y, Math.sin(a) * rInner),
        new THREE.Vector3(Math.cos(a) * rOuter, y, Math.sin(a) * rOuter)
      );
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        color: this.colors.grid,
        transparent: true,
        opacity: 0.65,
      })
    );
  }

  /** Swap the field palette when the page theme changes. */
  setTheme(theme) {
    this.theme = theme === "light" ? "light" : "dark";
    this.colors = PALETTES[this.theme];
    if (this.spineLine) {
      this.spineLine.material.color.setHex(this.colors.spine);
    }
    this.innerReticleLines.forEach((line) => {
      line.material.color.setHex(this.colors.ringInner);
    });
    this.ringMeshes.forEach((line, i) => {
      line.material.color.setHex(i === PROBE ? this.colors.probe : this.colors.ring);
    });
    if (this.probeBeads) {
      this.probeBeads.material.color.setHex(this.colors.probeBead);
    }
    if (this.grid && this.grid.material) {
      this.grid.material.color.setHex(this.colors.grid);
    }
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
    const col = s.colors;
    const cSafe = this.colors.streamSafe;
    const cMint = this.colors.streamMint;
    const cHarm = this.colors.streamHarm;

    for (let i = 0; i < s.N; i++) {
      let x = pos[i * 3];
      let y = pos[i * 3 + 1];
      let z = pos[i * 3 + 2];
      const speed = this.reduced ? 0.04 : s.speeds[i];
      const baseR = s.radius[i];
      const angle = s.seeds[i] + t * 0.08;

      // Always advance upward so there is never a stagnant pancake or empty black hole
      y += speed * 0.018;

      if (this.blocked && s.role[i] === 1 && y >= probeY - 0.05) {
        // Representation Rerouting / Circuit Breaker at Layer 16:
        // Deflect harmful subspace trajectory outward along the +v_harm contrast axis
        const progress = Math.min(1, (y - (probeY - 0.05)) / 0.55);
        const deflectR = baseR + progress * 0.85;
        x = Math.cos(angle) * deflectR + progress * 0.42;
        z = Math.sin(angle) * deflectR + progress * 0.08;
        col[i * 3] = cHarm.r;
        col[i * 3 + 1] = cHarm.g;
        col[i * 3 + 2] = cHarm.b;

        if (y > probeY + 0.52) {
          y = -1.55;
          x = Math.cos(angle) * baseR;
          z = Math.sin(angle) * baseR;
        }
      } else {
        // Core residual stream flows cleanly through the center of Layer 16 all the way to Layer 23
        x = Math.cos(angle) * baseR;
        z = Math.sin(angle) * baseR;
        if (y >= probeY && !this.blocked && s.role[i] === 1) {
          // Passed verification at Layer 16 -> subtle mint verification tint
          col[i * 3] = cSafe.r * 0.65 + cMint.r * 0.35;
          col[i * 3 + 1] = cSafe.g * 0.65 + cMint.g * 0.35;
          col[i * 3 + 2] = cSafe.b * 0.65 + cMint.b * 0.35;
        } else {
          col[i * 3] = cSafe.r;
          col[i * 3 + 1] = cSafe.g;
          col[i * 3 + 2] = cSafe.b;
        }
        if (y > 1.95) {
          y = -1.55;
        }
      }

      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
    }

    s.points.geometry.attributes.position.needsUpdate = true;
    s.points.geometry.attributes.color.needsUpdate = true;
    s.points.material.opacity = 0.62;

    // Ring reaction around Layer 16
    this.ringMeshes.forEach((ring, i) => {
      const d = Math.abs(i - PROBE);
      const near = Math.max(0, 1 - d / 7);
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4 - d * 0.45);
      const boost = this.harm * near * pulse * 0.5;
      ring.material.opacity = Math.min(1, ring.userData.baseOpacity + boost);
    });

    if (this.probeBeads) {
      const pulse = 0.6 + 0.4 * Math.sin(t * 3);
      this.probeBeads.material.size = 0.044 + this.harm * 0.024 * pulse;
      this.probeBeads.material.opacity = 0.8 + this.harm * 0.2;
    }
    if (this.haloRing) {
      this.haloRing.material.opacity = 0.22 + this.harm * 0.45;
    }
    if (this.probeSpokes) {
      this.probeSpokes.material.opacity = 0.28 + this.harm * 0.32;
    }

    // LAT Reading Vector (+v_harm) visibility
    const a = this.axis.userData;
    const target = 0.25 + this.harm * 0.7;
    a.lineMat.opacity += (target - a.lineMat.opacity) * 0.08;
    a.headMat.opacity = a.lineMat.opacity;
    a.originMat.opacity = Math.min(1, a.lineMat.opacity + 0.15);

    // Camera parallax + slow drift
    this.pointer.lerp(this.targetPointer, 0.05);
    const px = this.pointer.x;
    const py = this.pointer.y;
    if (!this.reduced) {
      this.camera.position.x = 2.25 + px * 0.5;
      this.camera.position.y = 1.38 - py * 0.3;
      this.camera.lookAt(0, 0.35, 0);
      this.root.rotation.y = Math.sin(t * 0.14) * 0.08 + px * 0.05;
    }

    this.renderer.render(this.scene, this.camera);
  }
}
