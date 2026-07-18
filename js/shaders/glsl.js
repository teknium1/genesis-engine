// glsl.js — shader sources for the Genesis Engine (v2).
//
// v2 change: the BASE dynamics are now proper Lenia (a known self-sustaining,
// glider-producing continuous CA), because the v1 custom flow scheme reliably
// either died to black or froze. On top of that stable base we layer the four
// research ingredients as *modulators* you can toggle:
//   - embedded local genome (per-cell mu/sigma that mutate + advect)      -> B,A channels
//   - metabolic energy economy (light -> energy -> gates growth)          -> G channel
//   - mass conservation (renormalize total mass toward the seeded budget)
//   - novelty/curiosity nudge (rare, gentle; CPU-driven)
//
// State texture channels per cell:
//   R = A       (Lenia activation / "mass" of a creature)
//   G = energy  (metabolic charge)
//   B = mu      (local growth-center gene)
//   A = sigma   (local growth-width gene)

export const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// PASS 1 — potential U = mass convolved with a Lenia ring kernel.
// Output: R = U (potential), G = mass passthrough.
// ---------------------------------------------------------------------------
export const POTENTIAL_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uState;
uniform vec2  uTexel;
uniform float uRadius;

float bump(float x, float m, float s){
  float d = (x - m) / s;
  return exp(-0.5 * d * d);
}

void main(){
  float R = uRadius;
  int Ri = int(R);
  float sum = 0.0, wsum = 0.0;
  for(int dy=-24; dy<=24; dy++){
    if(dy > Ri || dy < -Ri) continue;
    for(int dx=-24; dx<=24; dx++){
      if(dx > Ri || dx < -Ri) continue;
      float r = length(vec2(float(dx), float(dy))) / R;
      if(r > 1.0) continue;
      float k = bump(r, 0.5, 0.15);   // single Lenia ring
      float m = texture(uState, vUV + vec2(float(dx), float(dy)) * uTexel).r;
      sum += k * m; wsum += k;
    }
  }
  float U = (wsum > 0.0) ? sum / wsum : 0.0;
  outColor = vec4(U, texture(uState, vUV).r, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// PASS 2 — Lenia growth update + optional modulators.
// ---------------------------------------------------------------------------
export const STEP_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;

uniform sampler2D uState;   // R=mass G=energy B=mu A=sigma
uniform sampler2D uPot;     // R=U
uniform vec2  uTexel;
uniform float uDt;
uniform float uMuBase;      // global growth center (Lenia mu)
uniform float uSigBase;     // global growth width  (Lenia sigma)
uniform float uMut;         // mutation rate
uniform float uLight;       // light influx
uniform float uGenome;      // 1 = use local mu/sigma, mutate + drift
uniform float uMetabolism;  // 1 = energy gates growth
uniform float uMassConserve;// 1 = renormalize toward target mass
uniform float uMassScale;   // multiplicative correction from CPU (target/current)
uniform float uCuriosity;   // 0..1, rare gentle sparks
uniform float uTime;
uniform vec2  uPoke;
uniform float uPokeR;
uniform float uPokeAmt;
uniform float uPokeErase;   // 1 = erase instead of add

float bump(float x, float m, float s){ float d=(x-m)/s; return exp(-0.5*d*d); }
float hash(vec2 p){
  p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32);
  return fract(p.x*p.y);
}

void main(){
  vec4 s = texture(uState, vUV);
  float mass = s.r, energy = s.g, mu = s.b, sigma = s.a;
  float U = texture(uPot, vUV).r;

  // choose growth params: local genome if enabled & present, else global.
  float gmu  = (uGenome > 0.5 && mu > 0.001) ? mu : uMuBase;
  float gsig = (uGenome > 0.5 && sigma > 0.001) ? max(0.008, sigma) : uSigBase;

  // Lenia growth mapping in [-1,1].
  float growth = 2.0 * bump(U, gmu, gsig) - 1.0;

  // Metabolism: growth is *modulated* by energy (not hard-gated), so creatures
  // keep their locomotion but thrive/wither with the light economy.
  float gate = 1.0;
  if(uMetabolism > 0.5){
    float light = uLight * (0.55 + 0.45 * (1.0 - vUV.y));
    energy += (light * mass - 0.015 * mass) * uDt;      // photosynthesis - upkeep
    energy = clamp(energy, 0.0, 2.0);
    // soft modulation: never below 0.6 so gliders still move; scarcity just slows growth
    gate = (growth > 0.0) ? clamp(0.6 + energy, 0.6, 1.0) : 1.0;
    energy -= max(0.0, growth) * gate * uDt * 0.3;
    energy = max(0.0, energy);
  }

  float newMass = clamp(mass + uDt * growth * gate, 0.0, 1.0);

  // Mass conservation: gently rescale toward the seeded budget (CPU supplies the
  // ratio). This keeps a world from slowly bleeding or blowing up its total mass.
  if(uMassConserve > 0.5){
    newMass = clamp(newMass * mix(1.0, uMassScale, 0.5), 0.0, 1.0);
  }

  // Local genome: born matter gets a genome; living matter mutates + drifts so
  // the "gene" can evolve and spread. Drift = average with neighbours (advects
  // the gene along the creature).
  if(uGenome > 0.5){
    if(newMass > 0.02 && mu <= 0.001){
      mu = uMuBase + (hash(vUV*71.0+uTime)-0.5)*0.06;
      sigma = uSigBase + (hash(vUV*37.0-uTime)-0.5)*0.01;
    }
    if(newMass > 0.02){
      // drift toward neighbour genome (spatial coherence of a creature's gene)
      float mL=texture(uState,vUV-vec2(uTexel.x,0)).b, mR=texture(uState,vUV+vec2(uTexel.x,0)).b;
      float mD=texture(uState,vUV-vec2(0,uTexel.y)).b, mU=texture(uState,vUV+vec2(0,uTexel.y)).b;
      float nb=(mL+mR+mD+mU)*0.25;
      if(nb>0.001) mu = mix(mu, nb, 0.15);
      mu    = clamp(mu    + uMut*(hash(vUV*997.0+uTime)-0.5), 0.05, 0.35);
      sigma = clamp(sigma + uMut*(hash(vUV*631.0-uTime)-0.5)*0.4, 0.008, 0.06);
    }
  }

  // Curiosity: RARE, gentle sparks only when CPU says the world truly stalled.
  if(uCuriosity > 0.001){
    float spark = hash(vUV*311.0 + floor(uTime*3.0));
    if(spark > 1.0 - 0.0025 * uCuriosity){
      newMass = max(newMass, 0.55);
      mu = uMuBase + (hash(vUV*53.0+uTime)-0.5)*0.1;
      sigma = uSigBase;
      energy = max(energy, 0.7);
    }
  }

  // Pointer interaction.
  if(uPoke.x >= 0.0){
    float d = distance(vUV, uPoke);
    if(d < uPokeR){
      float w = 1.0 - d/uPokeR;
      if(uPokeErase > 0.5){
        newMass *= (1.0 - w);
      } else {
        newMass = clamp(newMass + uPokeAmt*w, 0.0, 1.0);
        if(mu <= 0.001){ mu = uMuBase; sigma = uSigBase; }
        energy = max(energy, 0.6*w);
      }
    }
  }

  outColor = vec4(newMass, energy, mu, sigma);
}`;

// ---------------------------------------------------------------------------
// RENDER — camera (pan/zoom) + view modes.
// uCam = (offsetX, offsetY, zoom, _) ; UV is transformed before sampling.
// ---------------------------------------------------------------------------
export const RENDER_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uState;
uniform sampler2D uPot;
uniform int uView;          // 0 species, 1 mass, 2 energy, 3 potential
uniform vec4 uCam;          // x,y offset (uv), z zoom, w aspect
uniform float uGenome;

vec3 hsv(float h,float s,float v){
  vec4 K=vec4(1.,2./3.,1./3.,3.);
  vec3 p=abs(fract(vec3(h)+K.xyz)*6.-K.www);
  return v*mix(K.xxx,clamp(p-K.xxx,0.,1.),s);
}

void main(){
  // camera transform: center, scale by zoom, re-center, then pan
  vec2 uv = (vUV - 0.5) / uCam.z + 0.5 + uCam.xy;
  // toroidal wrap so panning shows the wrap-around world
  uv = fract(uv);

  vec4 s = texture(uState, uv);
  float mass = s.r;
  vec3 col;

  if(uView == 0){
    float g = (uGenome > 0.5 && s.b > 0.001) ? s.b : 0.15;
    float hue = fract(0.5 + g * 2.2);
    col = hsv(hue, 0.85, pow(mass, 0.65));
  } else if(uView == 1){
    col = vec3(pow(mass,0.6)) * vec3(0.55,0.95,0.85);
  } else if(uView == 2){
    float e = clamp(s.g/1.5, 0.0, 1.0);
    col = mix(vec3(0.04,0.05,0.1), vec3(1.0,0.72,0.3), e) * (0.25+0.75*mass);
  } else {
    float U = texture(uPot, uv).r;
    col = hsv(fract(0.6 - U*0.7), 0.8, U) ;
  }

  vec2 d = vUV - 0.5;
  col *= 1.0 - 0.3*dot(d,d);
  outColor = vec4(col, 1.0);
}`;
