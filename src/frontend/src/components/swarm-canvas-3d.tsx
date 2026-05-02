import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'

import type { SwarmParams } from '@/components/swarm-canvas-2d'

const BOUND = 10 // half-size of the cubic volume agents wander in

type Agent = {
  position: THREE.Vector3
  velocity: THREE.Vector3
  history: Float32Array // ring buffer of XYZ positions, length = MAX_TRAIL * 3
  historyIndex: number // next slot to write
  historyFill: number // how many slots written (caps at MAX_TRAIL)
}

const MAX_TRAIL = 120 // upper bound; trailLength prop trims rendering

function useIsDark() {
  const [isDark, setIsDark] = useState(
    () =>
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('dark'),
  )
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains('dark'))
    })
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [])
  return isDark
}

function makeAgent(): Agent {
  return {
    position: new THREE.Vector3(
      (Math.random() - 0.5) * BOUND * 2,
      (Math.random() - 0.5) * BOUND * 2,
      (Math.random() - 0.5) * BOUND * 2,
    ),
    velocity: new THREE.Vector3(
      Math.random() - 0.5,
      Math.random() - 0.5,
      Math.random() - 0.5,
    ).normalize(),
    history: new Float32Array(MAX_TRAIL * 3),
    historyIndex: 0,
    historyFill: 0,
  }
}

function Swarm({
  paramsRef,
  isDark,
}: {
  paramsRef: React.RefObject<SwarmParams>
  isDark: boolean
}) {
  const agentsRef = useRef<Agent[]>([])
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const linesRef = useRef<THREE.LineSegments>(null)
  const tmpMatrix = useMemo(() => new THREE.Matrix4(), [])
  const { scene } = useThree()

  const lineGeometry = useMemo(() => {
    const geom = new THREE.BufferGeometry()
    const maxAgents = 256
    const segCount = (MAX_TRAIL - 1) * 2
    geom.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(maxAgents * segCount * 3), 3),
    )
    geom.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(maxAgents * segCount * 3), 3),
    )
    geom.setDrawRange(0, 0)
    return geom
  }, [])

  useEffect(() => () => lineGeometry.dispose(), [lineGeometry])

  const lineMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      }),
    [],
  )
  useEffect(() => () => lineMaterial.dispose(), [lineMaterial])

  const agentHex = isDark ? '#ffffff' : '#111118'
  const agentColor = useMemo(() => new THREE.Color(agentHex), [agentHex])

  useFrame(() => {
    const p = paramsRef.current
    if (!p) return

    const agents = agentsRef.current
    while (agents.length < p.agentCount) agents.push(makeAgent())
    if (agents.length > p.agentCount) agents.length = p.agentCount

    const trail = Math.min(MAX_TRAIL, Math.max(2, Math.round(p.trailLength)))
    const turn = p.turnJitter
    const speed = p.speed * 0.05
    const size = p.agentSize / 60

    const mesh = meshRef.current
    const lines = linesRef.current
    if (!mesh) return

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]
      a.velocity.x += (Math.random() - 0.5) * turn
      a.velocity.y += (Math.random() - 0.5) * turn
      a.velocity.z += (Math.random() - 0.5) * turn
      a.velocity.normalize()
      a.position.addScaledVector(a.velocity, speed)

      ;(['x', 'y', 'z'] as const).forEach((axis) => {
        if (a.position[axis] > BOUND) a.position[axis] -= BOUND * 2
        else if (a.position[axis] < -BOUND) a.position[axis] += BOUND * 2
      })

      const idx = a.historyIndex
      a.history[idx * 3] = a.position.x
      a.history[idx * 3 + 1] = a.position.y
      a.history[idx * 3 + 2] = a.position.z
      a.historyIndex = (a.historyIndex + 1) % MAX_TRAIL
      a.historyFill = Math.min(MAX_TRAIL, a.historyFill + 1)

      tmpMatrix.makeScale(size, size, size).setPosition(a.position)
      mesh.setMatrixAt(i, tmpMatrix)
    }

    mesh.count = agents.length
    mesh.instanceMatrix.needsUpdate = true

    if (lines) {
      const posAttr = lineGeometry.getAttribute(
        'position',
      ) as THREE.BufferAttribute
      const colorAttr = lineGeometry.getAttribute(
        'color',
      ) as THREE.BufferAttribute
      const positions = posAttr.array as Float32Array
      const colors = colorAttr.array as Float32Array

      let cursor = 0
      const baseR = agentColor.r
      const baseG = agentColor.g
      const baseB = agentColor.b

      for (let i = 0; i < agents.length; i++) {
        const a = agents[i]
        const pointsAvailable = Math.min(trail, a.historyFill)
        if (pointsAvailable < 2) continue
        for (let k = 0; k < pointsAvailable - 1; k++) {
          const oldIdx =
            (a.historyIndex - 1 - k - 1 + MAX_TRAIL * 2) % MAX_TRAIL
          const newIdx = (a.historyIndex - 1 - k + MAX_TRAIL * 2) % MAX_TRAIL
          const ax = a.history[newIdx * 3]
          const ay = a.history[newIdx * 3 + 1]
          const az = a.history[newIdx * 3 + 2]
          const bx = a.history[oldIdx * 3]
          const by = a.history[oldIdx * 3 + 1]
          const bz = a.history[oldIdx * 3 + 2]
          if (
            Math.abs(ax - bx) > BOUND ||
            Math.abs(ay - by) > BOUND ||
            Math.abs(az - bz) > BOUND
          ) {
            continue
          }
          const tNew = 1 - k / trail
          const tOld = 1 - (k + 1) / trail
          positions[cursor * 3] = ax
          positions[cursor * 3 + 1] = ay
          positions[cursor * 3 + 2] = az
          colors[cursor * 3] = baseR * tNew
          colors[cursor * 3 + 1] = baseG * tNew
          colors[cursor * 3 + 2] = baseB * tNew
          cursor++
          positions[cursor * 3] = bx
          positions[cursor * 3 + 1] = by
          positions[cursor * 3 + 2] = bz
          colors[cursor * 3] = baseR * tOld
          colors[cursor * 3 + 1] = baseG * tOld
          colors[cursor * 3 + 2] = baseB * tOld
          cursor++
        }
      }

      lineGeometry.setDrawRange(0, cursor)
      posAttr.needsUpdate = true
      colorAttr.needsUpdate = true
    }
  })

  useEffect(() => {
    if (linesRef.current) {
      linesRef.current.geometry = lineGeometry
      linesRef.current.material = lineMaterial
    }
  }, [lineGeometry, lineMaterial, scene])

  // Use unlit material so agents stay full brightness regardless of lighting,
  // ensuring max contrast against the bg.
  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, 256]}
        frustumCulled={false}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={agentHex} />
      </instancedMesh>
      <lineSegments ref={linesRef} frustumCulled={false} />
    </>
  )
}

export function SwarmCanvas3D({ params }: { params: SwarmParams }) {
  const paramsRef = useRef(params)
  paramsRef.current = params
  const isDark = useIsDark()

  const bgHex = isDark ? '#15151a' : '#fafafa'
  const gridMain = isDark ? '#444' : '#cfcfd4'
  const gridSub = isDark ? '#252529' : '#e7e7ea'

  return (
    <Canvas
      camera={{ position: [18, 14, 18], fov: 45 }}
      className="size-full rounded-md"
    >
      <color attach="background" args={[bgHex]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 10, 5]} intensity={0.8} />
      <Swarm paramsRef={paramsRef} isDark={isDark} />
      <OrbitControls enablePan={false} />
      <gridHelper args={[BOUND * 2, 10, gridMain, gridSub]} />
    </Canvas>
  )
}
