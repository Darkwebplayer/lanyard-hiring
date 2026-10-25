<script setup lang="ts">
// A list answer, one input per item with "Add another": the apply page and both move dialogs. listItems() reads it.
const items = defineModel<string[]>({ required: true })
defineProps<{ id?: string, label: string, name?: string, max?: number, required?: boolean, invalid?: boolean }>()
defineEmits<{ input: [] }>()
watchEffect(() => { if (!Array.isArray(items.value)) items.value = [''] }) // a field reset to '' starts with one empty item
</script>

<template>
  <div v-if="Array.isArray(items)" class="list">
    <div v-for="(_, i) in items" :key="i" class="item">
      <input
        v-model="items[i]" :id="i === 0 ? id : undefined" :name="name" :aria-label="`${label}, item ${i + 1}`"
        :required="required && i === 0" maxlength="200" :aria-invalid="invalid && i === 0 ? 'true' : undefined"
        @input="$emit('input')"
      >
      <button v-if="i > 0" type="button" class="btn btn-quiet btn-icon" :aria-label="`Remove item ${i + 1}`" @click="items.splice(i, 1)"><Icon name="x" /></button>
    </div>
    <button v-if="items.length < (max ?? 50)" type="button" class="btn btn-sm add" @click="items.push('')"><Icon name="plus" />Add another</button>
  </div>
</template>

<style scoped>
.list { display: grid; gap: 10px; }
.item { display: flex; gap: 6px; }
.add { justify-self: start; margin-top: -2px; }
</style>
