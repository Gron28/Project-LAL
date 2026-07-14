/**
 * Return the height of the tallest obstacle containing a world position.
 * Obstacles are centred at { x, z } and use their top surface as `y`.
 */
function getGroundHeight(x, z, obstacles) {
  let highestY = 0;

  for (const obstacle of obstacles) {
    const containsPoint =
      x >= obstacle.x - obstacle.width / 2 &&
      x <= obstacle.x + obstacle.width / 2 &&
      z >= obstacle.z - obstacle.depth / 2 &&
      z <= obstacle.z + obstacle.depth / 2;

    if (containsPoint) highestY = Math.max(highestY, obstacle.y);
  }

  return highestY;
}

function calculateMovement(direction, speed, delta) {
  return { x: direction.x * speed * delta, z: direction.z * speed * delta };
}

module.exports = { getGroundHeight, calculateMovement };
