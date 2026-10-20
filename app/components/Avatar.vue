<script setup lang="ts">
// Initials on the accent tint: one style for every person in the product.
defineProps<{ name: string | null | undefined, image?: string | null, size?: number }>()
</script>

<template>
  <span class="avatar" :style="size ? { '--size': `${size}px` } : undefined" aria-hidden="true">
    <img v-if="image" :src="image" alt="" referrerpolicy="no-referrer">
    <template v-else>{{ initials(name) }}</template>
  </span>
</template>
