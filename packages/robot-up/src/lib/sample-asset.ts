export const SAMPLE_ASSET_NAME = "sample://multi-xml-bundle";
export const SAMPLE_SCENE_PATH = "sample/scene.xml";
export const SAMPLE_ARM_PATH = "sample/industrial-arm.xml";
export const SAMPLE_MESH_PATH = "sample/assets/base_shell.obj";
export const SAMPLE_ISAAC_ASSET_NAME = "sample://factory-stage";
export const SAMPLE_STAGE_PATH = "sample/factory-cell.usda";

export const SAMPLE_SCENE_MJCF = `<mujoco model="industrial_arm_scene">
  <include file="industrial-arm.xml" />

  <asset>
    <material name="floor_grid" rgba="0.12 0.17 0.21 1" />
  </asset>

  <worldbody>
    <geom name="floor" type="plane" size="3 3 0.1" material="floor_grid" />
  </worldbody>
</mujoco>
`;

export const SAMPLE_MJCF = `<mujoco model="industrial_arm">
  <compiler angle="degree" meshdir="assets" />

  <asset>
    <mesh name="base_shell" file="base_shell.obj" scale="0.36 0.28 0.18" />
  </asset>

  <worldbody>
    <body name="base" pos="0 0 0.16">
      <geom mesh="base_shell" rgba="0.86 0.61 0.22 1" />

      <body name="column" pos="0 0 0.14">
        <geom type="box" size="0.07 0.07 0.16" rgba="0.24 0.73 0.63 1" />

        <body name="arm" pos="0 0 0.2" euler="0 18 30">
          <geom type="capsule" fromto="0 0 0 0.52 0 0.12" size="0.045" rgba="0.36 0.75 0.95 1" />

          <body name="wrist" pos="0.52 0 0.12" euler="0 -12 -18">
            <geom type="capsule" fromto="0 0 0 0.24 0 0.06" size="0.03" rgba="0.91 0.48 0.37 1" />

            <body name="tool" pos="0.24 0 0.06">
              <geom type="sphere" size="0.055" rgba="0.96 0.81 0.45 1" />
            </body>
          </body>
        </body>
      </body>
    </body>
  </worldbody>
</mujoco>
`;

export const SAMPLE_OBJ = `o base_shell
v -0.50 -0.50 -0.50
v 0.50 -0.50 -0.50
v 0.50 0.50 -0.50
v -0.50 0.50 -0.50
v -0.50 -0.50 0.50
v 0.50 -0.50 0.50
v 0.50 0.50 0.50
v -0.50 0.50 0.50
f 1 2 3
f 1 3 4
f 5 8 7
f 5 7 6
f 1 5 6
f 1 6 2
f 2 6 7
f 2 7 3
f 3 7 8
f 3 8 4
f 4 8 5
f 4 5 1
`;

export const SAMPLE_STAGE_USDA = `#usda 1.0
(
    defaultPrim = "World"
    upAxis = "Z"
    metersPerUnit = 0.01
)

def Xform "World"
{
    def Xform "RobotBase"
    {
        def Cube "Pedestal"
        {
            double size = 0.55
            double3 xformOp:translate = (0, 0, 0.275)
            uniform token[] xformOpOrder = ["xformOp:translate"]
        }

        def Xform "Arm"
        {
            double3 xformOp:translate = (0.28, 0, 0.62)
            double3 xformOp:rotateXYZ = (0, -18, 26)
            uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ"]

            def Capsule "Link"
            {
                double height = 0.9
                double radius = 0.08
                double3 xformOp:rotateXYZ = (0, 90, 0)
                uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]
            }

            def Sphere "Tool"
            {
                double radius = 0.13
                double3 xformOp:translate = (0.5, 0, 0.14)
                uniform token[] xformOpOrder = ["xformOp:translate"]
            }
        }
    }

    def Xform "Fixture"
    {
        double3 xformOp:translate = (-0.85, 0.42, 0.18)
        uniform token[] xformOpOrder = ["xformOp:translate"]

        def Cylinder "Post"
        {
            double height = 0.5
            double radius = 0.12
            double3 xformOp:translate = (0, 0, 0.25)
            uniform token[] xformOpOrder = ["xformOp:translate"]
        }
    }
}
`;
