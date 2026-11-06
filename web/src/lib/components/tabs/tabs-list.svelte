<script lang="ts">
  import { Tabs } from "bits-ui";
  import { cn } from "$lib/utils.ts";

  let {
    ref = $bindable(null),
    class: className = "",
    children,
    ...restProps
  } = $props();
</script>

<!--
  Deretan tombol tab: horizontal, wrap bila sempit
  (meniru .optbadges di tech_stack).
-->
<Tabs.List
  bind:ref
  class={cn("inline-flex w-fit flex-wrap items-center gap-1.5", className)}
  {...restProps}
>
  {@render children?.()}
</Tabs.List>
