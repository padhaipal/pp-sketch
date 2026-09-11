# geo-entity.module.ts

Registers `GeoEntityEntity` (also listed in
src/interfaces/database/data-source.ts), provides `GeoEntityService`, mounts
`GeoEntityController`, exports the service. Imported by AppModule and by
UserModule (staff-create / GET /users/:id resolve geo entities through it).
