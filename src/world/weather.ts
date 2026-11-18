// Weather presets and target atmospheric profiles. Pure data with no DOM or Three.js dependencies.
export type Weather = 'clear' | 'overcast' | 'rain' | 'snow' | 'mist';

export const WEATHERS: Record<Weather, true> = {
  clear: true,
  overcast: true,
  rain: true,
  snow: true,
  mist: true,
};

export interface WeatherProfile {
  cloudCover: number;
  cloudDensity: number;
  fogDensity: number;
  sunDim: number;
  hemiLift: number;
  fogTint: number;
  wetness: number;
  snowCover: number;
  valleyMist: number;
  rain: number;
  snow: number;
  cloudShadow: number;
}

export const WEATHER_PROFILES: Record<Weather, WeatherProfile> = {
  clear: {
    cloudCover: 0.28,
    cloudDensity: 0.56,
    fogDensity: 0.00014,
    sunDim: 1,
    hemiLift: 0,
    fogTint: 0,
    wetness: 0,
    snowCover: 0,
    valleyMist: 0.06,
    rain: 0,
    snow: 0,
    cloudShadow: 0.34,
  },
  overcast: {
    cloudCover: 0.76,
    cloudDensity: 0.78,
    fogDensity: 0.00028,
    sunDim: 0.74,
    hemiLift: 0.16,
    fogTint: 0.5,
    wetness: 0.12,
    snowCover: 0,
    valleyMist: 0.16,
    rain: 0,
    snow: 0,
    cloudShadow: 0.92,
  },
  rain: {
    cloudCover: 0.92,
    cloudDensity: 0.88,
    fogDensity: 0.00052,
    sunDim: 0.26,
    hemiLift: 0.22,
    fogTint: 0.88,
    wetness: 1,
    snowCover: 0,
    valleyMist: 0.38,
    rain: 1,
    snow: 0,
    cloudShadow: 0.42,
  },
  snow: {
    cloudCover: 0.85,
    cloudDensity: 0.82,
    fogDensity: 0.00058,
    sunDim: 0.45,
    hemiLift: 0.26,
    fogTint: 0.65,
    wetness: 0,
    snowCover: 1,
    valleyMist: 0.34,
    rain: 0,
    snow: 1,
    cloudShadow: 0.28,
  },
  mist: {
    cloudCover: 0.58,
    cloudDensity: 0.68,
    fogDensity: 0.00086,
    sunDim: 0.56,
    hemiLift: 0.28,
    fogTint: 0.68,
    wetness: 0.22,
    snowCover: 0,
    valleyMist: 1,
    rain: 0,
    snow: 0,
    cloudShadow: 0.18,
  },
};
