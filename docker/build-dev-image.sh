version=$(git describe --tags --abbrev=0)
version="dev-${version:1}"
registry="ghcr.io"
repository="cynova/directus"


echo $version


docker build \
	--build-arg VERSION=$version \
	--build-arg REPOSITORY=$repository \
	-t directus:temp \
	-f ./Dockerfile.dev \
	..

docker tag directus:temp "$registry/$repository:$version"
docker image rm directus:temp
