// engine.js — WebGL2 setup, ping-pong float textures, and the simulation loop core.
import { VERT, FLOW_FS, STEP_FS, RENDER_FS } from './shaders/glsl.js';

export class Engine {
  constructor(canvas, sizeW = 512, sizeH = 512) {
    this.canvas = canvas;
    this.W = sizeW;
    this.H = sizeH;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) { this.gl = null; return; }
    this.gl = gl;

    // Float render targets require this extension in WebGL2.
    this.floatLinear = gl.getExtension('OES_texture_float_linear');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      this.gl = null; return;
    }

    this._buildQuad();
    this.progFlow   = this._program(VERT, FLOW_FS);
    this.progStep   = this._program(VERT, STEP_FS);
    this.progRender = this._program(VERT, RENDER_FS);

    // Ping-pong state textures + a flow texture.
    this.stateA = this._tex();
    this.stateB = this._tex();
    this.flowT  = this._tex();
    this.fbo    = gl.createFramebuffer();

    this.src = this.stateA;
    this.dst = this.stateB;
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
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      console.error('shader compile error:', log, '\n', src.split('\n').map((l,i)=>`${i+1}: ${l}`).join('\n'));
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
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('program link: ' + gl.getProgramInfoLog(p));
    }
    // cache uniform locations lazily
    p._u = {};
    return p;
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

  // Upload a Float32Array (RGBA per cell) into the source texture.
  seed(data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.W, this.H, 0, gl.RGBA, gl.FLOAT, data);
  }

  _drawTo(tex) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, this.W, this.H);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Run one simulation step. `p` = params object from the UI/controller.
  step(p) {
    const gl = this.gl;
    const texel = [1 / this.W, 1 / this.H];

    // --- PASS 1: flow/potential -> flowT ---
    gl.useProgram(this.progFlow);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.uniform1i(this._u(this.progFlow, 'uState'), 0);
    gl.uniform2f(this._u(this.progFlow, 'uTexel'), texel[0], texel[1]);
    gl.uniform1f(this._u(this.progFlow, 'uRadius'), p.radius);
    gl.uniform1f(this._u(this.progFlow, 'uTime'), p.time);
    this._drawTo(this.flowT);

    // --- PASS 2: integrate -> dst ---
    gl.useProgram(this.progStep);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.uniform1i(this._u(this.progStep, 'uState'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.flowT);
    gl.uniform1i(this._u(this.progStep, 'uFlow'), 1);
    gl.uniform2f(this._u(this.progStep, 'uTexel'), texel[0], texel[1]);
    gl.uniform1f(this._u(this.progStep, 'uDt'), p.dt);
    gl.uniform1f(this._u(this.progStep, 'uFlowK'), p.flow);
    gl.uniform1f(this._u(this.progStep, 'uMut'), p.mut);
    gl.uniform1f(this._u(this.progStep, 'uLight'), p.light);
    gl.uniform1f(this._u(this.progStep, 'uMassConserve'), p.massConserve ? 1 : 0);
    gl.uniform1f(this._u(this.progStep, 'uMetabolism'), p.metabolism ? 1 : 0);
    gl.uniform1f(this._u(this.progStep, 'uGenome'), p.genome ? 1 : 0);
    gl.uniform1f(this._u(this.progStep, 'uCuriosity'), p.curiosity);
    gl.uniform1f(this._u(this.progStep, 'uTime'), p.time);
    gl.uniform2f(this._u(this.progStep, 'uPoke'), p.poke[0], p.poke[1]);
    gl.uniform1f(this._u(this.progStep, 'uPokeR'), p.pokeR);
    gl.uniform1f(this._u(this.progStep, 'uPokeAmt'), p.pokeAmt);
    this._drawTo(this.dst);

    // swap
    const tmp = this.src; this.src = this.dst; this.dst = tmp;
  }

  // Render current state to the screen.
  render(view) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.progRender);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.uniform1i(this._u(this.progRender, 'uState'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.flowT);
    gl.uniform1i(this._u(this.progRender, 'uFlow'), 1);
    gl.uniform1i(this._u(this.progRender, 'uView'), view);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Read the current state back to CPU at reduced resolution for metrics.
  // Returns a Float32Array of RGBA at (rw x rh) by sampling the full texture
  // into a temp framebuffer. To keep it cheap we read the full buffer but the
  // caller downsamples in JS.
  readback(buf) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.src, 0);
    gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.FLOAT, buf);
    return buf;
  }
}
