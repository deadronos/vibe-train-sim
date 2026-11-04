"""Builds public/assets/assetpack.glb from code.

Run:  npm run assets
Conventions:
  * Every asset is one top-level object named in ASSETS below; signal lamps stay separate children.
  * Vehicles and signals face Blender -Y, which the glTF exporter turns into +Z (three.js lookAt forward).
  * Units are metres. Origin sits on the rail head / ground at the centre of the footprint.
"""
import math
import os
import random

import bmesh
import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "public", "assets", "assetpack.glb")
PREVIEW = os.path.join(ROOT, "tools", "blender", "preview.png")

random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)
MATS = {}


def mat(name, color, rough=0.6, metal=0.0, emissive=None, strength=1.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emissive:
        b.inputs["Emission Color"].default_value = (*emissive, 1)
        b.inputs["Emission Strength"].default_value = strength
    MATS[name] = m
    return m


# Palette (linear colour). Materials whose names start with glow_ are driven by night factor in the game.
M = dict(
    livery=mat("livery_teal", (0.015, 0.16, 0.2), 0.32, 0.25),
    livery2=mat("livery_cream", (0.8, 0.72, 0.52), 0.35, 0.1),
    stripe=mat("livery_yellow", (0.9, 0.5, 0.03), 0.4),
    freight=mat("livery_oxide", (0.18, 0.035, 0.018), 0.5, 0.15),
    freight_band=mat("livery_white", (0.75, 0.75, 0.72), 0.45),
    light=mat("livery_blue", (0.02, 0.05, 0.18), 0.3, 0.25),
    roof=mat("roof_grey", (0.11, 0.115, 0.12), 0.55, 0.5),
    steel=mat("steel_dark", (0.03, 0.03, 0.033), 0.55, 0.9),
    bright=mat("steel_bright", (0.45, 0.45, 0.47), 0.3, 1.0),
    rust=mat("rust", (0.2, 0.075, 0.03), 0.85, 0.2),
    glass=mat("glass_dark", (0.012, 0.02, 0.025), 0.08, 0.6),
    win=mat("glow_window", (0.02, 0.03, 0.035), 0.12, 0.4, (1.0, 0.72, 0.38), 0.0),
    head=mat("glow_headlight", (0.8, 0.8, 0.75), 0.15, 0.3, (1.0, 0.92, 0.75), 0.0),
    tail=mat("glow_tail", (0.25, 0.01, 0.01), 0.2, 0.0, (1.0, 0.02, 0.01), 0.0),
    lamp=mat("glow_lamp", (0.85, 0.82, 0.7), 0.3, 0.0, (1.0, 0.78, 0.45), 0.0),
    brick=mat("brick", (0.28, 0.095, 0.06), 0.9),
    stone=mat("stone", (0.17, 0.16, 0.145), 0.92),
    concrete=mat("concrete", (0.21, 0.205, 0.19), 0.88),
    paving=mat("paving", (0.14, 0.14, 0.14), 0.85),
    tile=mat("roof_tile", (0.24, 0.06, 0.04), 0.75),
    slate=mat("roof_slate", (0.06, 0.07, 0.085), 0.6),
    plaster=mat("plaster", (0.68, 0.62, 0.5), 0.9),
    plaster2=mat("plaster_blue", (0.28, 0.4, 0.46), 0.9),
    wood=mat("wood", (0.13, 0.065, 0.03), 0.8),
    bark=mat("bark", (0.075, 0.045, 0.028), 0.95),
    pine=mat("leaf_pine", (0.018, 0.075, 0.03), 0.85),
    oak=mat("leaf_oak", (0.06, 0.17, 0.028), 0.8),
    birch=mat("leaf_birch", (0.21, 0.27, 0.04), 0.8),
    rock=mat("rock", (0.2, 0.19, 0.17), 0.95),
    black=mat("signal_black", (0.008, 0.008, 0.009), 0.45, 0.2),
    white=mat("signal_white", (0.75, 0.75, 0.72), 0.5),
    red=mat("signal_red", (0.3, 0.01, 0.01), 0.25, 0.0, (1, 0.03, 0.02), 0.0),
    amber=mat("signal_amber", (0.3, 0.17, 0.01), 0.25, 0.0, (1, 0.55, 0.03), 0.0),
    green=mat("signal_green", (0.01, 0.2, 0.08), 0.25, 0.0, (0.05, 1, 0.4), 0.0),
)


def new_obj(name, bm, material, smooth=False):
    me = bpy.data.meshes.new(name)
    if smooth:
        for f in bm.faces:
            f.smooth = True
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def box(name, center, size, material, bevel=0.0, taper_top=None):
    """Axis box; taper_top=(sx, sy) scales the top face, for roofs and hoods."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]
        v.co.y *= size[1]
        v.co.z *= size[2]
        if taper_top and v.co.z > 0:
            v.co.x *= taper_top[0]
            v.co.y *= taper_top[1]
        v.co += Vector(center)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=2, affect="EDGES", profile=0.5)
    bm.normal_update()
    return new_obj(name, bm, material)


def cyl(name, a, b, r, material, seg=12, r2=None, cap=True):
    """Cylinder/cone between two points."""
    a, b = Vector(a), Vector(b)
    d = b - a
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=d.length)
    quat = Vector((0, 0, 1)).rotation_difference(d.normalized())
    for v in bm.verts:
        v.co = quat @ v.co + (a + b) / 2
    return new_obj(name, bm, material, smooth=True)


def blob(name, center, radius, material, noise=0.2, sub=2, squash=1.0):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=radius)
    for v in bm.verts:
        k = 1 + random.uniform(-noise, noise)
        v.co *= k
        v.co.z *= squash
        v.co += Vector(center)
    bm.normal_update()
    return new_obj(name, bm, material)


def prism(name, verts_xz, y0, y1, material):
    """Extrudes a closed polygon in the XZ plane along Y (window frames, gables, cab noses)."""
    bm = bmesh.new()
    a = [bm.verts.new((x, y0, z)) for x, z in verts_xz]
    b = [bm.verts.new((x, y1, z)) for x, z in verts_xz]
    n = len(verts_xz)
    bm.faces.new(a)
    bm.faces.new(list(reversed(b)))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[j], a[i], b[i], b[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return new_obj(name, bm, material)


def join(name, parts):
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    return ob


# ---------------------------------------------------------------- rolling stock
def bogie():
    p = [box("frame", (0, 0, 0.62), (2.0, 2.55, 0.28), M["steel"], 0.03)]
    for y in (-0.95, 0.95):
        p.append(cyl("axle", (-0.8, y, 0.46), (0.8, y, 0.46), 0.07, M["steel"], 8))
        for x in (-0.76, 0.76):
            p.append(cyl("wheel", (x - 0.05, y, 0.46), (x + 0.05, y, 0.46), 0.46, M["bright"], 20))
            p.append(cyl("hub", (x * 1.1 - 0.06, y, 0.46), (x * 1.1 + 0.06, y, 0.46), 0.16, M["steel"], 10))
    for x in (-1.04, 1.04):
        p.append(box("spring", (x, 0, 0.72), (0.14, 1.1, 0.26), M["rust"]))
    return join("bogie", p)


def body_section(hw, z0, z1, roof_h):
    """Coach cross-section: slight tumblehome plus a curved roof."""
    pts = [(-hw * 0.93, z0), (hw * 0.93, z0), (hw, z0 + 0.5), (hw * 0.96, z1)]
    for i in range(1, 7):
        t = i / 7 * math.pi
        pts.append((math.cos(t) * hw * 0.96, z1 + math.sin(t) * roof_h))
    pts += [(-hw * 0.96, z1), (-hw, z0 + 0.5)]
    return pts


def window_row(ys, w, z0, z1, hw, material):
    out = []
    for y in ys:
        for sx in (-1, 1):
            out.append(box("win", (sx * hw, y, (z0 + z1) / 2), (0.05, w, z1 - z0), material, 0.012))
    return out


def coach():
    L = 22.0
    hw, z0, z1 = 1.42, 1.15, 3.35
    p = [prism("shell", body_section(hw, z0, z1, 0.42), -L / 2, L / 2, M["livery2"])]
    # Colour bands run the entire side, above and below the windows.
    for sx in (-1, 1):
        p.append(box("band", (sx * (hw + 0.005), 0, 1.55), (0.03, L - 0.2, 0.8), M["livery"]))
        p.append(box("stripe", (sx * (hw + 0.012), 0, 2.02), (0.02, L - 0.2, 0.08), M["stripe"]))
    p += window_row([-8 + i * 2.32 for i in range(8)], 1.55, 2.25, 3.05, hw + 0.01, M["win"])
    for y in (-9.9, 9.9):
        for sx in (-1, 1):
            p.append(box("door", (sx * (hw + 0.012), y, 2.2), (0.03, 1.25, 2.0), M["livery"]))
            p.append(box("doorwin", (sx * (hw + 0.03), y, 2.75), (0.03, 0.6, 0.7), M["win"]))
    p.append(prism("roofcap", [(-1.2, 3.68), (1.2, 3.68), (1.0, 3.82), (-1.0, 3.82)], -L / 2 + 0.3, L / 2 - 0.3, M["roof"]))
    p.append(box("under", (0, 0, 1.04), (2.5, L - 1, 0.22), M["steel"]))
    for y in (-3.5, 0.5, 4):
        p.append(box("tank", (0, y, 0.8), (1.7, 1.8, 0.42), M["steel"], 0.03))
    for y in (-L / 2 - 0.15, L / 2 + 0.15):
        p.append(box("gangway", (0, y, 2.4), (1.5, 0.35, 2.3), M["steel"]))
        p.append(box("buffer", (0, y * 1.012, 1.05), (0.34, 0.5, 0.34), M["steel"]))
    return join("coach", p)


def wagon_box():
    L = 15.0
    p = [box("body", (0, 0, 2.2), (2.8, L, 2.2), M["rust"], 0.02)]
    for i in range(11):
        y = -L / 2 + 0.7 + i * (L - 1.4) / 10
        for sx in (-1, 1):
            p.append(box("rib", (sx * 1.42, y, 2.2), (0.05, 0.1, 2.2), M["steel"]))
    p.append(prism("roof", [(-1.48, 3.3), (1.48, 3.3), (1.2, 3.62), (-1.2, 3.62)], -L / 2, L / 2, M["roof"]))
    p.append(box("floor", (0, 0, 1.04), (2.7, L + 0.2, 0.22), M["steel"]))
    for sx in (-1, 1):
        p.append(box("door", (sx * 1.44, 0, 2.2), (0.04, 3.0, 2.0), M["livery"]))
    for y in (-L / 2 - 0.2, L / 2 + 0.2):
        p.append(box("buffer", (0, y, 1.05), (0.34, 0.5, 0.34), M["steel"]))
    return join("wagon_box", p)


def wagon_tank():
    L = 13.0
    p = [box("floor", (0, 0, 1.08), (2.6, L + 0.2, 0.24), M["steel"])]
    p.append(cyl("tank", (0, -L / 2 + 0.2, 2.45), (0, L / 2 - 0.2, 2.45), 1.25, M["roof"], 24))
    for y in (-L / 2 + 0.2, L / 2 - 0.2):
        p.append(blob("cap", (0, y, 2.45), 1.25, M["roof"], 0.0, 3))
    p.append(cyl("dome", (0, 0, 3.6), (0, 0, 4.0), 0.5, M["steel"], 14))
    for y in (-L / 2 - 0.2, L / 2 + 0.2):
        p.append(box("buffer", (0, y, 1.05), (0.34, 0.5, 0.34), M["steel"]))
    return join("wagon_tank", p)


def locomotive(name="loco_diesel", L=19.0, livery=None, stripe=None, fans=(-3.8, 3.8)):
    """An original bonnet-free diesel-electric with a wedge cab at each end. Nose faces -Y."""
    livery = livery or M["livery"]
    stripe = stripe or M["stripe"]
    hw, z0, z1 = 1.48, 1.2, 3.55
    y_cab = -L / 2 + 3.3
    p = [prism("hood", body_section(hw, z0, z1, 0.5), y_cab, L / 2 - 3.3, livery)]

    # Wedge cabs: lofted cross-sections sloping back to the windscreen.
    def cab(sign):
        bm = bmesh.new()
        stations = [(0.0, 1.0, 1.0), (1.0, 1.0, 1.0), (2.2, 0.98, 0.94), (2.75, 0.9, 0.62), (3.3, 0.78, 0.42)]
        rings = []
        section = body_section(hw, z0, z1, 0.5)
        y_start = sign * (L / 2 - 3.3)
        for off, sx, sz in stations:
            ring = [bm.verts.new((x * sx, y_start + sign * off, z0 + (z - z0) * sz)) for x, z in section]
            rings.append(ring)
        n = len(section)
        for a, b in zip(rings[:-1], rings[1:]):
            for i in range(n):
                j = (i + 1) % n
                bm.faces.new((a[i], a[j], b[j], b[i]))
        bm.faces.new(rings[-1])
        bm.faces.new(list(reversed(rings[0])))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        out = [new_obj("cab", bm, livery)]
        # Windscreen panel on the raked section, side windows and nose stripe.
        ys = y_start + sign * 2.25
        ye = y_start + sign * 2.8
        scr = bmesh.new()
        coords = [(-1.2, ys, 3.22), (1.2, ys, 3.22), (1.1, ye, 2.42), (-1.1, ye, 2.42)]
        vs = [scr.verts.new(c) for c in coords]
        scr.faces.new(vs)
        bmesh.ops.recalc_face_normals(scr, faces=scr.faces[:])
        for v in scr.verts:
            v.co.y += sign * 0.05
        bmesh.ops.solidify(scr, geom=scr.faces[:], thickness=0.04)
        out.append(new_obj("screen", scr, M["glass"]))
        for sx in (-1, 1):
            out.append(box("sidewin", (sx * (hw - 0.01), y_start + sign * 1.0, 2.85), (0.05, 1.3, 0.75), M["glass"], 0.015))
            out.append(box("nosebar", (sx * 0.0, y_start + sign * 3.33, 1.65), (2.3, 0.05, 0.42), stripe))
            out.append(cyl("headlamp", (sx * 0.85, y_start + sign * 3.3, 2.12), (sx * 0.85, y_start + sign * 3.42, 2.12), 0.14, M["head"], 12))
            out.append(cyl("taillamp", (sx * 1.15, y_start + sign * 3.27, 2.12), (sx * 1.15, y_start + sign * 3.38, 2.12), 0.08, M["tail"], 10))
        return out

    p += cab(-1) + cab(1)
    for sx in (-1, 1):
        p.append(box("stripe", (sx * (hw + 0.01), 0, 1.72), (0.03, L - 7, 0.16), stripe))
        grilles = int((L - 9) / 1.65) + 1
        for i in range(grilles):
            y = (i - (grilles - 1) / 2) * 1.65
            p.append(box("grille", (sx * (hw - 0.03), y, 3.0), (0.08, 1.35, 0.55), M["steel"]))
        for y in (-(L / 2 - 3.7), L / 2 - 3.7):
            p.append(box("door", (sx * (hw + 0.01), y, 2.5), (0.03, 0.85, 1.95), M["roof"]))
    for y in fans:
        p.append(cyl("fan", (0, y, 3.98), (0, y, 4.1), 0.75, M["steel"], 20))
        p.append(cyl("fanhub", (0, y, 4.08), (0, y, 4.14), 0.2, M["bright"], 10))
    p.append(box("deck", (0, 0, 1.08), (2.85, L - 0.4, 0.26), M["steel"]))
    p.append(box("fuel", (0, 0, 0.72), (2.2, 5.6, 0.62), M["steel"], 0.06))
    for y in (-L / 2 - 0.05, L / 2 + 0.05):
        p.append(box("pilot", (0, y * 0.985, 0.75), (2.5, 0.38, 0.65), stripe, 0.03, (0.95, 0.8)))
    return join(name, p)


# ---------------------------------------------------------------- lineside
def signal():
    """Colour-light signal. The lamp lenses stay separate so the game can light them individually."""
    p = [cyl("mast", (0, 0, 0), (0, 0, 4.8), 0.075, M["white"], 10, r2=0.06)]
    p.append(cyl("base", (0, 0, 0), (0, 0, 0.35), 0.28, M["concrete"], 10, r2=0.2))
    p.append(box("head", (0, -0.1, 4.75), (0.46, 0.14, 1.32), M["black"], 0.05))
    # Horizontal hoods above each lens.
    zs = dict(red=5.12, amber=4.75, green=4.38)
    for z in zs.values():
        p.append(box("hood", (0, -0.27, z + 0.13), (0.3, 0.26, 0.03), M["black"]))
    body = join("signal_mast", p)
    for key, name in (("red", "lamp_red"), ("amber", "lamp_amber"), ("green", "lamp_green")):
        lamp = cyl(name, (0, -0.17, zs[key]), (0, -0.2, zs[key]), 0.125, M[key], 16)
        lamp.parent = body
    return body


def platform():
    """10 m tile, front edge at local +X. Repeated along the track by the game."""
    p = [box("slab", (0, 0, -2.0), (4.6, 10.02, 6.0), M["concrete"])]
    p.append(box("top", (0, 0, 1.03), (4.6, 10.02, 0.06), M["paving"]))
    p.append(box("edge", (2.1, 0, 1.065), (0.4, 10.02, 0.02), M["stripe"]))
    return join("platform", p)


def lamp_post():
    p = [cyl("post", (0, 0, 0), (0, 0, 4.6), 0.06, M["steel"], 8)]
    p.append(cyl("arm", (0, 0, 4.6), (0.65, 0, 4.72), 0.04, M["steel"], 6))
    p.append(box("shade", (0.75, 0, 4.72), (0.4, 0.2, 0.05), M["steel"]))
    p.append(box("lamp", (0.75, 0, 4.67), (0.33, 0.14, 0.05), M["lamp"]))
    return join("lamp_post", p)


def shelter():
    p = []
    for x in (-1.2, 1.2):
        for y in (-3.5, 3.5):
            p.append(cyl("post", (x, y, 0), (x, y, 2.9), 0.06, M["steel"], 8))
    p.append(prism("canopy", [(-1.8, 2.9), (1.8, 2.9), (1.8, 3.02), (0, 3.34), (-1.8, 3.02)], -4.2, 4.2, M["slate"]))
    p.append(box("wall", (-1.2, 0, 1.2), (0.08, 6.6, 2.1), M["glass"]))
    p.append(box("bench", (-0.8, 0, 0.5), (0.4, 2.8, 0.07), M["wood"]))
    return join("shelter", p)


def station_building():
    W, D, H = 7.0, 16.0, 4.0
    p = [box("base", (0, 0, -1.7), (W + 0.2, D + 0.2, 4.6), M["stone"])]
    p.append(box("wall", (0, 0, H / 2 + 0.3), (W, D, H), M["brick"]))
    p.append(prism("roof", [(-W / 2 - 0.6, H + 0.3), (W / 2 + 0.6, H + 0.3), (0, H + 3.1)], -D / 2 - 0.4, D / 2 + 0.4, M["slate"]))
    p.append(box("clock", (W / 2 + 0.02, 0, H + 0.05), (0.08, 1.0, 1.0), M["white"]))
    for y in (-6, -3, 3, 6):
        for sx in (-1, 1):
            p.append(box("win", (sx * (W / 2 + 0.01), y, 2.6), (0.06, 1.25, 1.9), M["win"]))
            p.append(box("lintel", (sx * (W / 2 + 0.02), y, 3.72), (0.08, 1.55, 0.25), M["stone"]))
    for sx in (-1, 1):
        p.append(box("door", (sx * (W / 2 + 0.01), 0, 1.75), (0.06, 1.7, 2.9), M["wood"]))
    p.append(box("chimney", (0, 4.8, H + 2.6), (0.8, 0.8, 2.4), M["brick"]))
    # Canopy to the track side (+X).
    p.append(prism("awning", [(W / 2 - 0.1, 3.95), (W / 2 + 3.4, 3.45), (W / 2 + 3.4, 3.55), (W / 2 - 0.1, 4.08)], -D / 2, D / 2, M["roof"]))
    for y in (-7, -2.3, 2.3, 7):
        p.append(cyl("column", (W / 2 + 3.1, y, 0), (W / 2 + 3.1, y, 3.5), 0.07, M["steel"], 8))
    return join("station_building", p)


def house(name, wall, roof, w=7.0, d=9.0, h=3.0):
    p = [box("wall", (0, 0, h / 2), (w, d, h), wall), box("footing", (0, 0, -1.5), (w + 0.2, d + 0.2, 3.0), M["stone"])]
    p.append(prism("roof", [(-w / 2 - 0.4, h), (w / 2 + 0.4, h), (0, h + w * 0.48)], -d / 2 - 0.3, d / 2 + 0.3, roof))
    for y in (-d * 0.28, d * 0.28):
        for sx in (-1, 1):
            p.append(box("win", (sx * (w / 2 + 0.01), y, h * 0.58), (0.06, 1.1, 1.15), M["win"]))
    for sy in (-1, 1):
        p.append(box("win", (0, sy * (d / 2 + 0.01), h * 0.58), (1.1, 0.06, 1.15), M["win"]))
    p.append(box("door", (w / 2 + 0.01, 0, 1.05), (0.06, 1.05, 2.1), M["wood"]))
    p.append(box("chimney", (w * 0.2, d * 0.28, h + w * 0.42), (0.6, 0.6, 1.5), M["brick"]))
    return join(name, p)


def pier():
    """Bridge pier with its top at z=0; the 60 m shaft simply runs into the ground or riverbed."""
    p = [box("cap", (0, 0, -0.45), (6.2, 1.3, 0.9), M["concrete"], 0.04)]
    p.append(box("shaft", (0, 0, -30.9), (3.0, 1.2, 60), M["stone"]))
    return join("pier", p)


def abutment():
    p = [box("wall", (0, 0, -2.5), (7.0, 2.0, 5.0), M["stone"], 0.03, (0.95, 0.85))]
    for sx in (-1, 1):
        p.append(box("wing", (sx * 3.6, 1.0, -2.0), (0.5, 4.0, 4.0), M["stone"], 0.0, (1, 0.8)))
    return join("abutment", p)


def buffer_stop():
    p = [box("beam", (0, 0, 1.05), (2.6, 0.32, 0.42), M["stripe"], 0.03)]
    for x in (-1.0, 1.0):
        p.append(box("leg", (x, 0.55, 0.6), (0.2, 1.4, 0.2), M["steel"]))
        p.append(box("brace", (x, 0.1, 0.7), (0.2, 0.2, 1.2), M["steel"]))
        p.append(cyl("buf", (x * 0.75, 0, 1.05), (x * 0.75, -0.42, 1.05), 0.17, M["bright"], 12))
    p.append(cyl("lamp", (0, 0, 1.28), (0, 0, 1.46), 0.09, M["tail"], 10))
    return join("buffer_stop", p)


def switch_stand():
    p = [box("base", (0, 0, 0.14), (0.5, 0.7, 0.28), M["steel"], 0.02)]
    p.append(cyl("rod", (0, 0, 0.28), (0, 0, 1.2), 0.03, M["steel"], 8))
    return join("switch_stand", p)


# ---------------------------------------------------------------- nature
def pine(name, scale=1.0):
    h = 13.0 * scale
    p = [cyl("trunk", (0, 0, 0), (0, 0, h * 0.5), 0.26 * scale, M["bark"], 6, r2=0.1)]
    tiers = 4
    for i in range(tiers):
        t = i / tiers
        z0 = h * (0.2 + 0.66 * t)
        z1 = z0 + h * 0.36
        r = (3.2 * (1 - t * 0.75)) * scale
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=r, radius2=0.05, depth=z1 - z0)
        for v in bm.verts:
            if v.co.z < 0:
                v.co.x *= random.uniform(0.85, 1.15)
                v.co.y *= random.uniform(0.85, 1.15)
                v.co.z -= random.uniform(0, 0.3) * scale
            v.co.z += (z0 + z1) / 2
        p.append(new_obj("tier", bm, M["pine"]))
    return join(name, p)


def broadleaf(name, leaf, scale=1.0):
    h = 5.2 * scale
    p = [cyl("trunk", (0, 0, 0), (0, 0, h), 0.3 * scale, M["bark"], 6, r2=0.14)]
    for (dx, dy, dz, r) in [(0, 0, 2.6, 3.4), (2, 0.8, 1.4, 2.4), (-1.8, 1.2, 1.2, 2.3), (0.4, -2, 1.0, 2.4), (-0.5, -0.3, 4.2, 2.3)]:
        p.append(blob("crown", (dx * scale, dy * scale, h + dz * scale - 1.4), r * scale, leaf, 0.14, 1, 0.9))
    return join(name, p)


def rock(name, r, sub=2):
    return blob(name, (0, 0, r * 0.3), r, M["rock"], 0.24, sub, 0.7)


ASSETS = [
    bogie, coach, wagon_box, wagon_tank, locomotive,
    lambda: locomotive("loco_freight", 22.0, M["freight"], M["freight_band"], (-6.2, -2.1, 2.1, 6.2)),
    lambda: locomotive("loco_light", 16.0, M["light"], M["livery2"], (0.0,)),
    signal, platform, lamp_post, shelter, station_building,
    lambda: house("house_a", M["plaster"], M["tile"]),
    lambda: house("house_b", M["plaster2"], M["slate"], 6.0, 11.0, 3.2),
    lambda: house("house_c", M["brick"], M["slate"], 8.0, 8.0, 5.4),
    pier, abutment, buffer_stop, switch_stand,
    lambda: pine("tree_pine"),
    lambda: broadleaf("tree_oak", M["oak"]),
    lambda: broadleaf("tree_birch", M["birch"], 0.72),
    lambda: rock("rock_a", 2.2),
    lambda: rock("rock_b", 3.6),
]

objects = [fn() for fn in ASSETS]
for o in bpy.data.objects:
    o.select_set(False)

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_apply=True,
    export_materials="EXPORT",
    export_animations=False,
    export_cameras=False,
    export_lights=False,
    export_yup=True,
)
print("WROTE", OUT, os.path.getsize(OUT), "bytes")

# ---------------------------------------------------------------- contact sheet
x = 0
for o in objects:
    if o.name.startswith("pier"):
        continue
    o.location = (x, 0, 0)
    x += max(o.dimensions.x, 4) + 3
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 4
sun.rotation_euler = (math.radians(50), 0, math.radians(35))
bpy.context.collection.objects.link(sun)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
bpy.context.collection.objects.link(cam)
cam.data.type = "ORTHO"
cam.data.ortho_scale = x * 1.02
cam.location = (x / 2, -80, 40)
cam.rotation_euler = (math.radians(65), 0, 0)
scene = bpy.context.scene
scene.camera = cam
scene.world = bpy.data.worlds.new("w")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.6, 0.65, 1)
scene.render.resolution_x = 1800
scene.render.resolution_y = 500
scene.render.filepath = PREVIEW
try:
    scene.render.engine = "BLENDER_EEVEE"
except TypeError:
    scene.render.engine = "BLENDER_WORKBENCH"
bpy.ops.render.render(write_still=True)
print("PREVIEW", PREVIEW)
