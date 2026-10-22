<script setup lang="ts">
import FormBuilder from '~/components/flow/FormBuilder.vue'

const source = useJobFlowSource(useRoute().params.id as string)
</script>

<template>
  <FormBuilder :source="source" />
</template>
