<script lang="ts">
  import { Tabs } from "bits-ui";
  import { cn } from "$lib/utils.ts";

  let {
    ref = $bindable(null),
    value = $bindable(undefined),
    class: className = "",
    children,
    ...restProps
  } = $props();
</script>

<!--
  Tabs Althea — primitif bits-ui dengan styling sendiri.
  Susunan vertikal: daftar tombol di ATAS, konten di BAWAH
  (flex-col, bukan baris). Gaya "line": trigger aktif diberi
  garis bawah via data-state="active" (attr bits-ui, lihat
  design/TABS.md).
-->
<Tabs.Root
  bind:ref
  bind:value
  class={cn("flex flex-col gap-2", className)}
  {...restProps}
>
  {@render children?.()}
</Tabs.Root>
