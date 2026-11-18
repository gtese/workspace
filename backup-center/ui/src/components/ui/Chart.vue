<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
])

const props = defineProps({
  option: { type: Object, required: true },
  height: { type: [Number, String], default: 260 },
})

const el = ref(null)
let chart = null
let observer = null

const heightStyle = computed(() =>
  typeof props.height === 'number' ? `${props.height}px` : props.height,
)

function render() {
  if (!chart) return
  chart.setOption(props.option || {}, true)
}

onMounted(() => {
  if (!el.value) return
  chart = echarts.init(el.value)
  render()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => chart?.resize())
    observer.observe(el.value)
  }
})

watch(
  () => props.option,
  () => render(),
  { deep: true },
)

onBeforeUnmount(() => {
  observer?.disconnect()
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div ref="el" :style="{ height: heightStyle, width: '100%' }" />
</template>
