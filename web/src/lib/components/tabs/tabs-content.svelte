<script lang="ts">
  import { Tabs } from "bits-ui";
  import { cn } from "$lib/utils.ts";

  let {
    ref = $bindable(null),
    value,
    tabindex = -1,
    class: className = "",
    children,
    ...restProps
  } = $props();
</script>

<!--
  Panel konten tab.
  tabindex default -1: untuk panel yang konten pertamanya focusable
  (input/button/textarea) — tombol Tab langsung melompat ke elemen
  tersebut. Panel statis (pre/teks) lewati tabindex={0} agar panel
  masih bisa difokus keyboard (pola WAI-ARIA tabs, design/TABS.md).
-->
<Tabs.Content
  bind:ref
  {value}
  {tabindex}
  class={cn("flex-1 text-sm outline-none", className)}
  {...restProps}
>
  {@render children?.()}
</Tabs.Content>
