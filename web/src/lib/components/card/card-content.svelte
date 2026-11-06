<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils.ts";

  let {
    ref = $bindable(null),
    class: className = "",
    children,
    ...restProps
  } = $props();
</script>

<div bind:this={ref} class={cn("px-4 py-3", className)} {...restProps}>
  {@render children?.()}
</div>
