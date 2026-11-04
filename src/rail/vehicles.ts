// Everything that differs between vehicles. A new type needs a row here and a model with the same name.
export type CarType = 'loco_diesel' | 'loco_freight' | 'loco_light' | 'coach' | 'wagon_box' | 'wagon_tank';

export interface Car {
  type: CarType;
  flip: boolean;
  /** Wagons only. Saves from before wagons could be empty leave it out, which means loaded. */
  loaded?: boolean;
}

interface Traction {
  power: number; // kW
  tractive: number; // kN at the rail
  dynamic: number; // kN of engine braking
}

export interface Vehicle {
  length: number; // m
  mass: { empty: number; loaded: number }; // t
  brake: { empty: number; loaded: number }; // kN at full service braking; heavier wagons get stronger brakes
  topSpeed: number; // m/s
  traction?: Traction;
}

const kmh = (v: number) => v / 3.6;
const fixed = (v: number) => ({ empty: v, loaded: v });

export const VEHICLES: Record<CarType, Vehicle> = {
  // All-round diesel.
  loco_diesel: {
    length: 20,
    mass: fixed(90),
    brake: fixed(75),
    topSpeed: kmh(140),
    traction: { power: 2800, tractive: 260, dynamic: 150 },
  },
  // Heavy and strong at low speed, with little power to spare higher up.
  loco_freight: {
    length: 23,
    mass: fixed(126),
    brake: fixed(70),
    topSpeed: kmh(100),
    traction: { power: 3200, tractive: 420, dynamic: 260 },
  },
  // Light and quick, but short of grip and pulling force.
  loco_light: {
    length: 17,
    mass: fixed(68),
    brake: fixed(60),
    topSpeed: kmh(160),
    traction: { power: 2200, tractive: 215, dynamic: 100 },
  },
  coach: { length: 23, mass: fixed(42), brake: fixed(36), topSpeed: kmh(160) },
  wagon_box: { length: 16, mass: { empty: 22, loaded: 38 }, brake: { empty: 12, loaded: 17 }, topSpeed: kmh(100) },
  wagon_tank: { length: 14, mass: { empty: 24, loaded: 72 }, brake: { empty: 12, loaded: 26 }, topSpeed: kmh(100) },
};

const loadOf = (c: Car) => (c.loaded === false ? 'empty' : 'loaded');
export const carMass = (c: Car) => VEHICLES[c.type].mass[loadOf(c)];
export const carBrake = (c: Car) => VEHICLES[c.type].brake[loadOf(c)];
