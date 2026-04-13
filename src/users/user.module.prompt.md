Standard NestJS module.
* Imports `TypeOrmModule.forFeature([UserEntity])` to register the UserEntity repository.
* Provides and exports UserService so other modules (e.g. InboundModule) can inject it.
