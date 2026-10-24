<script setup lang="ts">
// here, not in nuxt.config: with SSR on, config head must serialise, and a function doesn't
useHead({ titleTemplate: t => (t ? `${t} · Hiring` : 'Hiring') })
</script>

<template>
  <NuxtRouteAnnouncer />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <Toasts />
</template>
