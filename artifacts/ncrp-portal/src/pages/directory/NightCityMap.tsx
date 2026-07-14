import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useListLore, type LoreEntrySummary } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, MapPin } from "lucide-react";
import { districtLabel, type DistrictValue } from "@/lib/districts";
import mapImage from "@assets/gk5g5y2f1ln81_1784064405878.jpg";

// Polygons are hand-traced against the source map image
// (attached_assets/gk5g5y2f1ln81_1784064405878.jpg, 1900x2300 px), following
// the colored district borders drawn on the map. Coordinates are in the
// image's native pixel space; the SVG viewBox keeps them aligned at any
// rendered size.
const VIEW_W = 1900;
const VIEW_H = 2300;

type DistrictShape = {
  value: DistrictValue;
  color: string;
  labelPos: [number, number];
  points: string;
};

const DISTRICT_SHAPES: DistrictShape[] = [
  {
    value: "watson",
    color: "#ef4444",
    labelPos: [700, 460],
    points:
      "854,203 669,236 502,315 397,416 363,529 401,653 531,743 584,675 613,590 736,648 821,716 896,711 959,585 981,405 926,248",
  },
  {
    value: "westbrook",
    color: "#f97316",
    labelPos: [1050, 870],
    points:
      "896,714 981,539 1048,595 1171,674 1260,663 1293,741 1249,899 1204,1034 1115,1135 1015,1056 937,966 888,944 870,854 888,775",
  },
  {
    value: "city_center",
    color: "#eab308",
    labelPos: [690, 940],
    points:
      "569,849 888,854 888,944 865,988 803,1022 736,1033 569,1033 513,988 468,932 479,887",
  },
  {
    value: "heywood",
    color: "#22c55e",
    labelPos: [700, 1160],
    points:
      "569,1033 736,1038 803,1022 865,993 937,970 1015,1056 981,1146 892,1247 803,1303 691,1292 569,1224 502,1134 468,1056",
  },
  {
    value: "santo_domingo",
    color: "#3b82f6",
    labelPos: [1080, 1300],
    points:
      "1015,1056 1115,1135 1204,1039 1249,1056 1282,1124 1282,1258 1249,1371 1193,1472 1115,1528 1015,1510 926,1438 881,1348 892,1247 981,1146",
  },
  {
    value: "pacifica",
    color: "#a855f7",
    labelPos: [640, 1470],
    points:
      "535,1292 691,1297 803,1308 881,1354 870,1461 792,1573 669,1663 558,1659 446,1573 413,1472 435,1371",
  },
  {
    value: "north_badlands",
    color: "#64748b",
    labelPos: [520, 130],
    points:
      "0,0 1900,0 1900,420 1300,420 981,405 926,248 854,203 669,236 502,315 200,400 0,300",
  },
  {
    value: "eastern_badlands",
    color: "#0ea5e9",
    labelPos: [1580, 1180],
    points:
      "1300,420 1900,420 1900,1950 1350,1850 1282,1450 1290,741 1300,540",
  },
  {
    value: "southern_badlands",
    color: "#78716c",
    labelPos: [450, 1900],
    points:
      "0,1450 446,1573 558,1659 669,1663 792,1573 881,1461 1100,1650 1350,1850 1900,1950 1900,2300 0,2300",
  },
];

export default function NightCityMap() {
  const [, navigate] = useLocation();
  const { data: entries, isLoading } = useListLore();
  const [hovered, setHovered] = useState<DistrictValue | null>(null);

  const byDistrict = useMemo(() => {
    const map = new Map<string, LoreEntrySummary>();
    for (const e of entries ?? []) {
      if (e.district && !map.has(e.district)) map.set(e.district, e);
    }
    return map;
  }, [entries]);

  const hoveredEntry = hovered ? byDistrict.get(hovered) : undefined;

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <Link href="/directory/lore">
        <Button variant="ghost" className="rounded-none font-mono text-xs text-muted-foreground -ml-2" data-testid="link-map-back">
          <ArrowLeft className="w-4 h-4 mr-1" /> LORE DIRECTORY
        </Button>
      </Link>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-display" data-testid="text-map-title">NIGHT CITY MAP</h1>
          <p className="font-mono text-xs text-muted-foreground mt-2">
            Hover a district to highlight it. Click to open its lore entry.
          </p>
        </div>
        <div className="font-mono text-xs border border-border bg-card/50 px-3 py-2 min-w-[220px]" data-testid="text-map-hover-info">
          {hovered ? (
            <>
              <div className="font-display tracking-widest text-nc-cyan flex items-center gap-1">
                <MapPin className="w-3 h-3" /> {districtLabel(hovered)}
              </div>
              <div className="text-muted-foreground mt-1">
                {hoveredEntry ? `Lore: ${hoveredEntry.name}` : isLoading ? "Loading lore..." : "No lore entry tagged yet"}
              </div>
            </>
          ) : (
            <span className="text-muted-foreground">Hover a district...</span>
          )}
        </div>
      </div>

      <div className="relative border border-nc-cyan/20 bg-card/30 p-1">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="w-full h-auto block"
          role="img"
          aria-label="Interactive map of Night City districts"
          data-testid="svg-night-city-map"
        >
          <image href={mapImage} x={0} y={0} width={VIEW_W} height={VIEW_H} />
          {DISTRICT_SHAPES.map((d) => {
            const entry = byDistrict.get(d.value);
            const isHovered = hovered === d.value;
            return (
              <g key={d.value}>
                <polygon
                  points={d.points}
                  fill={d.color}
                  fillOpacity={isHovered ? 0.28 : 0}
                  stroke={d.color}
                  strokeOpacity={isHovered ? 0.9 : 0}
                  strokeWidth={6}
                  className={entry ? "cursor-pointer" : "cursor-default"}
                  style={{ transition: "fill-opacity 150ms, stroke-opacity 150ms" }}
                  onMouseEnter={() => setHovered(d.value)}
                  onMouseLeave={() => setHovered((h) => (h === d.value ? null : h))}
                  onClick={() => {
                    if (entry) navigate(`/directory/lore/${entry.id}`);
                  }}
                  data-testid={`polygon-district-${d.value}`}
                />
                {isHovered && (
                  <g pointerEvents="none">
                    <rect
                      x={d.labelPos[0] - 190}
                      y={d.labelPos[1] - 44}
                      width={380}
                      height={entry ? 96 : 88}
                      fill="#0a0a0a"
                      fillOpacity={0.85}
                      stroke={d.color}
                      strokeWidth={2}
                    />
                    <text
                      x={d.labelPos[0]}
                      y={d.labelPos[1]}
                      textAnchor="middle"
                      fill={d.color}
                      fontSize={40}
                      fontFamily="monospace"
                      fontWeight="bold"
                    >
                      {districtLabel(d.value)?.toUpperCase()}
                    </text>
                    <text
                      x={d.labelPos[0]}
                      y={d.labelPos[1] + 38}
                      textAnchor="middle"
                      fill="#e5e5e5"
                      fontSize={26}
                      fontFamily="monospace"
                    >
                      {entry ? `→ ${entry.name}` : "No lore entry yet"}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {DISTRICT_SHAPES.map((d) => {
          const entry = byDistrict.get(d.value);
          const inner = (
            <div
              className={`border px-3 py-2 font-mono text-xs flex items-center gap-2 ${entry ? "cursor-pointer hover:bg-card" : "opacity-60"}`}
              style={{ borderColor: d.color }}
              onMouseEnter={() => setHovered(d.value)}
              onMouseLeave={() => setHovered((h) => (h === d.value ? null : h))}
              data-testid={`card-district-${d.value}`}
            >
              <span className="w-2 h-2 shrink-0" style={{ backgroundColor: d.color }} />
              <span className="truncate">
                {districtLabel(d.value)}
                <span className="text-muted-foreground"> — {entry ? entry.name : "no lore yet"}</span>
              </span>
            </div>
          );
          return entry ? (
            <Link key={d.value} href={`/directory/lore/${entry.id}`}>{inner}</Link>
          ) : (
            <div key={d.value}>{inner}</div>
          );
        })}
      </div>
    </div>
  );
}
