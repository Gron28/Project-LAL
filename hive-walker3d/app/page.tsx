"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

export default function Scene() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mountRef.current) return;

    // --- Setup Scene ---
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb); // Sky blue
    scene.fog = new THREE.Fog(0x87ceeb, 10, 50);

    const camera = new THREE.PerspectiveCamera(75, (window.innerWidth / window.innerHeight) as number, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    mountRef.current?.appendChild(renderer.domElement);

    // --- Lights ---
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const sunLight = new THREE.DirectionalLight(0xffffff, 1);
    sunLight.position.set(10, 20, 10);
    scene.add(sunLight);

    // --- Objects ---
    // Ground (Infinite-ish)
    const groundGeo = new THREE.PlaneGeometry(1000, 1000);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x3ea05e });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // Obstacles (Boxes and Ramps)
    const obstacles: THREE.Mesh[] = [];
    const createObstacle = (x: number, z: number, w: number, d: number, h: number) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const mat = new THREE.MeshStandardMaterial({ color: 0x8b4513 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, h / 2, z);
      scene.add(mesh);
      obstacles.push(mesh);
    };

    createObstacle(0, -10, 5, 5, 2); // A box
    createObstacle(10, -15, 8, 4, 3); // A larger box
    createObstacle(-10, -20, 10, 10, 1.5); // A ramp-like area

    // Player (A simple cube)
    const playerGeo = new THREE.BoxGeometry(1, 2, 1);
    const playerMat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const player = new THREE.Mesh(playerGeo, playerMat);
    player.position.set(0, 1, 0);
    scene.add(player);

    // --- Controls & State ---
    const keys = { w: false, a: false, s: false, d: false };
    let yaw = 0;
    let pitch = 0;
    let isLocked = false;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'w') keys.w = true;
      if (e.key.toLowerCase() === 'a') keys.a = true;
      if (e.key.toLowerCase() === 's') keys.s = true;
      if (e.key.toLowerCase() === 'd') keys.d = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'w') keys.w = false;
      if (e.key.toLowerCase() === 'a') keys.a = false;
      if (e.key.toLowerCase() === 's') keys.s = false;
      if (e.key.toLowerCase() === 'd') keys.d = false;
    };

    const onPointerDown = () => {
      mountRef.current?.requestPointerLock();
    };

    // --- Animation Loop ---
    let frameId: number;
    const clock = new THREE.Clock();

    const animate = () => {
      frameId = requestAnimationFrame(animate);
      const delta = clock.getDelta();

      if (isLocked) {
        // Movement logic
        const speed = 5 * delta;
        const direction = new THREE.Vector3();
        
        if (keys.w) direction.z -= Math.cos(yaw) * Math.sin(pitch); // Simplified but works for basic movement
        // Wait, let's do it properly with rotation
        // Actually, standard 3D movement:
        const moveDir = new THREE.Vector3();
        if (keys.w) moveDir.z -= 1;
        if (keys.s) moveDir.z += 1;
        if (keys.a) moveDir.x -= 1;
        if (keys.d) moveDir.x += 1;

        moveDir.normalize().applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)));
        player.position.add(moveDir.multiplyScalar(speed));

        // Height sampling
        let bestHeight = 1;
        for (const obs of obstacles) {
          const box = new THREE.Box3().setFromObject(obs);
          if (box.containsPoint(new THREE.Vector3(player.position.x, 0.1, player.position.z))) {
             bestHeight = Math.max(bestHeight, box.max.y);
          }
        }
        // The player's center is at height + 1 (since it's 2 units tall)
        player.position.y = bestHeight + 1;

        // Camera follow logic
        const camOffset = new THREE.Vector3(0, 3, 8);
        const camRotation = new THREE.Euler(pitch, yaw, 0);
        const cameraObj = new THREE.Object3D();
        cameraObj.position.copy(player.position).add(camOffset);
        // This is a bit simplified but works for the requirement
      }

      // Corrected Camera Logic:
      // The camera should follow behind the player and look at them or ahead of them.
      const camDist = 8;
      const camHeight = 3;
      
      // We'll use a simple approach where the camera is offset from the player based on yaw/pitch
      // But since we want "third-person", let's just keep it simple:
      camera.position.x = player.position.x - Math.sin(yaw) * Math.cos(pitch) * camDist;
      camera.position.y = player.position.y + Math.sin(pitch) * camDist + camHeight;
      camera.position.z = player.position.z + Math.cos(yaw) * Math.cos(pitch) * camDist;
      
      // Actually, let's just use a fixed offset relative to the player's orientation if we had one, 
      // but since we don't have a complex model yet, let's stick to:
      camera.position.x = player.position.x - Math.sin(yaw) * camDist;
      camera.position.y = player.position.y + camHeight;
      camera.position.z = player.position.z + Math.cos(yaw) * camDist;
      
      camera.lookAt(player.position);

      renderer.render(scene, camera);
    };

    // Mouse movement for yaw/pitch
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement === mountRef.current) {
        yaw -= e.movementX * 0.005;
        pitch -= e.movementY * 0.005;
        pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, pitch));
      }
    };

    // Setup listeners
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    mountRef.current?.addEventListener('click', onPointerDown);

    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    // Pointer lock logic
    const handlePointerLockChange = () => {
      isLocked = document.pointerLockElement === mountRef.current;
    };
    document.addEventListener('pointerlockchange', handlePointerLockChange);

    animate();

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('resize', handleResize);
      mountRef.current?.removeEventListener('click', onPointerDown);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      cancelAnimationFrame(frameId);
      playerGeo.dispose();
      playerMat.dispose();
      groundGeo.dispose();
      groundMat.dispose();
      for (const obstacle of obstacles) {
        obstacle.geometry.dispose();
        const materials = Array.isArray(obstacle.material) ? obstacle.material : [obstacle.material];
        materials.forEach((material) => material.dispose());
      }
      renderer.dispose();
      renderer.domElement.remove();
    };

  }, []);

  return <div ref={mountRef} style={{ width: "100vw", height: "100vh" }} />;
}
