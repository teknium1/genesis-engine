// engine.js — WebGL2 setup, MRT ping-pong float textures, Lenia passes, camera, readback.
// v3: TWO state textures per generation (tex0 primary, tex1 aux) written together
// via gl.drawBuffers (multiple render targets).
import { VERT, POTENTIAL_FS, STEP_FS, RENDER_FS } from './shaders/glsl.js';

export class Engine {
  constructor(canvas, sizeW = 512, sizeH = 512) {
    this.canvas = canvas;
    this.W = sizeW; this.H = sizeH;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) { this.gl = null; return; }
    this.gl = gl;
    this.floatLinear = gl.getExtension('OES_texture_float_linear');
    if (!gl.getExtension('EXT_color_buffer_float')) { this.gl = null; return; }

    this._buildQuad();
    this.progPot    = this._program(VERT, POTENTIAL_FS);
    this.progStep   = this._program(VERT, STEP_FS);
    this.progRender = this._program(VERT, RENDER_FS);

    // ping-pong PAIRS: {s0, s1}
    this.a = { s0: this._tex(), s1: this._tex() };
    this.b = { s0: this._tex(), s1: this._tex() };
    this.potT = this._tex();
    this.fboStep = gl.createFramebuffer();   // MRT: two color attachments
    this.fboRead = gl.createFramebuffer();   // single attachment for readback
    this.src = this.a; this.dst = this.b;
  }
  ok() { return !!this.gl; }

  _buildQuad() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }
  _shader(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      console.error('shader compile error:', log);
      throw new Error('shader compile: ' + log);
    }
    return sh;
  }
  _program(vs, fs) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    p._u = {}; return p;
  }
  _u(prog, name) {
    if (!(name in prog._u)) prog._u[name] = this.gl.getUniformLocation(prog, name);
    return prog._u[name];
  }
  _tex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.W, this.H, 0, gl.RGBA, gl.FLOAT, null);
    const filt = this.floatLinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return t;
  }
  _upload(tex, data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.W, this.H, 0, gl.RGBA, gl.FLOAT, data);
  }
  // seed accepts {s0, s1} float arrays
  seed(world) {
    this._upload(this.src.s0, world.s0);
    this._upload(this.src.s1, world.s1);
  }

  step(p) {
    const gl = this.gl;
    const texel = [1 / this.W, 1 / this.H];

    // PASS 1: potential (reads src.s0 -> potT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboStep);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.potT, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.progPot);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.src.s0);
    gl.uniform1i(this._u(this.progPot, 'uState'), 0);
    gl.uniform2f(this._u(this.progPot, 'uTexel'), texel[0], texel[1]);
    gl.uniform1f(this._u(this.progPot, 'uRadius'), p.radius);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // PASS 2: MRT step (reads src.s0, src.s1, potT -> dst.s0, dst.s1)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.dst.s0, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.dst.s1, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.useProgram(this.progStep);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.src.s0);
    gl.uniform1i(this._u(this.progStep, 'uState'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.src.s1);
    gl.uniform1i(this._u(this.progStep, 'uAux'), 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.potT);
    gl.uniform1i(this._u(this.progStep, 'uPot'), 2);
    const U = this._u.bind(this), P = this.progStep;
    gl.uniform2f(U(P,'uTexel'), texel[0], texel[1]);
    gl.uniform1f(U(P,'uDt'), p.dt);
    gl.uniform1f(U(P,'uMuBase'), p.mu);
    gl.uniform1f(U(P,'uSigBase'), p.sigma);
    gl.uniform1f(U(P,'uMut'), p.mut);
    gl.uniform1f(U(P,'uLight'), p.light);
    gl.uniform1f(U(P,'uGenome'), p.genome ? 1 : 0);
    gl.uniform1f(U(P,'uMetabolism'), p.metabolism ? 1 : 0);
    gl.uniform1f(U(P,'uEat'), p.eat ? 1 : 0);
    gl.uniform1f(U(P,'uPredPayoff'), p.predPayoff);
    gl.uniform1f(U(P,'uMassConserve'), p.massConserve ? 1 : 0);
    gl.uniform1f(U(P,'uMassScale'), p.massScale);
    gl.uniform1f(U(P,'uCuriosity'), p.curiosity);
    gl.uniform1f(U(P,'uTime'), p.time);
    gl.uniform2f(U(P,'uPoke'), p.poke[0], p.poke[1]);
    gl.uniform1f(U(P,'uPokeR'), p.pokeR);
    gl.uniform1f(U(P,'uPokeAmt'), p.pokeAmt);
    gl.uniform1f(U(P,'uPokeErase'), p.pokeErase ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // reset draw buffers so subsequent single-target draws behave
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    const tmp = this.src; this.src = this.dst; this.dst = tmp;
  }

  render(view, cam, opt) {
    const gl = this.gl;
    opt = opt || {};
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.progRender);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.src.s0);
    gl.uniform1i(this._u(this.progRender, 'uState'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.src.s1);
    gl.uniform1i(this._u(this.progRender, 'uAux'), 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.potT);
    gl.uniform1i(this._u(this.progRender, 'uPot'), 2);
    gl.uniform1i(this._u(this.progRender, 'uView'), view);
    gl.uniform4f(this._u(this.progRender, 'uCam'), cam.x, cam.y, cam.zoom, 1.0);
    gl.uniform1f(this._u(this.progRender, 'uGenome'), 1.0);
    gl.uniform1f(this._u(this.progRender, 'uShowLight'), opt.showLight ? 1 : 0);
    gl.uniform1f(this._u(this.progRender, 'uLightGrad'), opt.lightGrad ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Read one of the current source textures ('s0' or 's1') into buf.
  readback(buf, which) {
    const gl = this.gl;
    const tex = (which === 's1') ? this.src.s1 : this.src.s0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboRead);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.FLOAT, buf);
    return buf;
  }
}
