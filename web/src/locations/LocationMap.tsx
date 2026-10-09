import { lazy, Suspense, type ComponentProps } from 'react';

// The map (MapView.tsx, with Leaflet) loads when it's first shown, so pages without one don't carry it.
const MapView = lazy(() => import('./MapView.tsx'));

export default function LocationMap(props: ComponentProps<typeof MapView>) {
  return (
    <Suspense fallback={<div className="map-box map-loading" style={{ height: props.height || 360 }} />}>
      <MapView {...props} />
    </Suspense>
  );
}
